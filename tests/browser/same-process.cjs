const { launch, waitFor, reports, server, resultPath } = require('./harness.cjs')
const { spawn } = require('node:child_process')
const { writeFile } = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await launch('same-process', { headed: true })
  const profiles = []
  try {
    const handoff = spawn(process.env.LC_CHROME_BINARY, [
      `--user-data-dir=${browser.dir}`, '--profile-directory=Profile 1',
      '--no-first-run', '--no-default-browser-check',
      `--load-extension=${path.resolve(__dirname, '../../build')}`, 'about:blank',
    ], { stdio: 'ignore' })
    await waitFor(() => handoff.exitCode !== null || handoff.signalCode !== null, 'profile launch handoff')
    const workers = await waitFor(async () => {
      const targets = (await browser.cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'service_worker' && target.url.endsWith('/js/background.js'))
      return targets.length === 2 && targets
    }, 'two profile workers in one browser process')
    assert.notEqual(workers[0].browserContextId, workers[1].browserContextId)
    for (const [index, worker] of workers.entries()) {
      const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
      const evaluate = expression => browser.cdp.evaluate(sessionId, expression)
      await waitFor(() => evaluate("typeof chrome !== 'undefined' && !!chrome.runtime?.id"), 'profile initialization')
      await evaluate("chrome.storage.local.set({configuration:'ipAddress',timezone:'America/Los_Angeles',locale:'en-US',lat:34.05,lon:-118.24,fontMode:'auto'})")
      const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(`${base}/?id=P${index}`)},active:true})`)
      profiles.push({ index, worker, evaluate, tab })
    }
    const applied = profile => profile.evaluate(`chrome.storage.session.get('lc-time-tab:${profile.tab.id}').then(data=>data['lc-time-tab:${profile.tab.id}']?.code==='applied')`)
    await waitFor(() => profiles.every(profile => reports.get(`P${profile.index}`)?.zone === 'America/Los_Angeles'), 'both profiles use the same IP region')
    for (const profile of profiles) await waitFor(() => applied(profile), 'verified document')
    console.log('PASS: two profiles in one browser process independently apply the same saved IP region')

    const second = profiles[1]
    const target = (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.url === `${base}/?id=P1`)
    await browser.cdp.send('Target.openDevTools', { targetId: target.targetId })
    for (const profile of profiles) await profile.evaluate(`chrome.tabs.reload(${profile.tab.id})`)
    await waitFor(() => profiles.every(profile => reports.get(`P${profile.index}`)?.initial === 'America/Los_Angeles'), 'first page script after reload with DevTools open')
    for (const profile of profiles) await waitFor(() => applied(profile), 'verified after reload')
    console.log('PASS: opening native DevTools on the second profile and reloading both preserves their region')

    const popupTab = await second.evaluate("chrome.tabs.create({url:chrome.runtime.getURL('html/popup.html'),active:false})")
    const popupTarget = await waitFor(async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find(target => target.browserContextId === second.worker.browserContextId && target.url.endsWith('/html/popup.html')), 'popup in second profile')
    const { sessionId: popupSession } = await browser.cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })
    const popup = expression => browser.cdp.evaluate(popupSession, expression)
    await waitFor(() => popup("!!document.querySelector('#ipTimezoneToggle')?.checked && document.querySelector('#saveStatus')?.dataset.state==='saved'"), 'popup verifies second profile')

    // Seed the stale persisted state, keeping the actual native connection live.
    // This reproduces the recovery bug deterministically, not its unknown trigger.
    const stale = `chrome.storage.session.set({'lc-time-tab:${second.tab.id}':{tabId:${second.tab.id},ok:false,code:'paused',message:'legacy pause'}})`
    await second.evaluate(stale)
    const rechecked = await popup(`chrome.runtime.sendMessage({type:'check-current-tab',tabId:${second.tab.id}})`)
    assert.equal(rechecked.code, 'applied')
    console.log('PASS: a stale paused record cannot block verification of a live connection')

    await second.evaluate(`chrome.debugger.detach({tabId:${second.tab.id}})`)
    await second.evaluate(stale)
    const paused = await popup(`chrome.runtime.sendMessage({type:'check-current-tab',tabId:${second.tab.id}})`)
    assert.equal(paused.code, 'paused')
    assert.doesNotMatch(paused.message, /取消/)
    await waitFor(() => reports.get('P1')?.zone === 'Asia/Shanghai', 'actual lost connection')
    await popup("document.querySelector('#reloadButton').click()")
    await waitFor(() => reports.get('P1')?.initial === 'America/Los_Angeles' && reports.get('P1')?.zone === 'America/Los_Angeles', 'popup recovery')
    await waitFor(() => popup("document.querySelector('#saveStatus').dataset.state==='saved'"), 'popup verified after recovery')
    assert.equal(reports.get('P0').zone, 'America/Los_Angeles')
    console.log('PASS: second-profile popup recovery restores the real document without resetting the first profile')

    // Exercise the button without changing the system clipboard.
    await popup("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedDiagnostic=text}}});document.querySelector('#diagnosticsButton').click()")
    const diagnostic = await waitFor(() => popup('window.copiedDiagnostic && JSON.parse(window.copiedDiagnostic)'), 'copied diagnostic')
    assert.equal(diagnostic.extension.version, '1.4.1')
    assert.equal(diagnostic.connection.owned, true)
    assert.equal(diagnostic.connection.actual.timezone, 'America/Los_Angeles')
    assert.equal(diagnostic.connection.actual.language, 'en-US')
    assert.equal(diagnostic.status.diagnostics.requested.mode, 'ipAddress')
    assert.ok(!JSON.stringify(diagnostic).includes(base))
    await popup("navigator.clipboard.writeText=async()=>{throw Error('unavailable')};document.querySelector('#diagnosticsButton').click()")
    await waitFor(() => popup("!document.querySelector('#diagnosticsPanel').hidden && document.querySelector('#diagnosticsOutput').value.includes('America/Los_Angeles')"), 'manual copy fallback')
    console.log('PASS: diagnostic button reports current connection/region/browser version and supports manual copying')

    await writeFile(await resultPath('same-process-results.json'), JSON.stringify({
      browserVersion: await browser.cdp.send('Browser.getVersion'),
      profiles: profiles.map(profile => ({ context: profile.worker.browserContextId, report: reports.get(`P${profile.index}`) })),
      diagnostic,
    }, null, 2))
    await second.evaluate(`chrome.tabs.remove(${popupTab.id})`)
  } finally {
    await browser.close()
    server.closeAllConnections()
    server.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
