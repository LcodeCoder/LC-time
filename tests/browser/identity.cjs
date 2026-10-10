// Isolate Chrome's native same-name/different-ID infobar conflict. The probes
// use chrome.debugger, and the test never clicks the browser's Cancel button.
const { launchBrowser, waitFor, sleep, resultPath } = require('./harness.cjs')
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises')
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const manifest = require('../../manifest.json')

async function scenario(fixed) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lc-time-identity-'))
  const copies = [path.join(root, 'copy-a'), path.join(root, 'copy-b')]
  for (const [index, directory] of copies.entries()) {
    await mkdir(directory)
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'LC-time', version: '1.0',
      ...(fixed ? { key: manifest.key } : {}), permissions: ['debugger'],
    }))
    await writeFile(path.join(directory, 'identity-probe.html'), '<!doctype html><script src="identity-probe.js"></script>')
    await writeFile(path.join(directory, 'identity-probe.js'), `
      globalThis.copyIndex = ${index};
      globalThis.events = [];
      chrome.debugger.onDetach.addListener((source, reason) => events.push({source, reason}));
    `)
  }
  // The command-line path is inherited by the second profile. Load copy A
  // through CDP only into the first profile so the two profiles really use
  // different directories. Inert fixture pages run only when opened below.
  const browser = await launchBrowser('identity', {
    headed: true, extensionPaths: [],
    args: ['--enable-unsafe-extension-debugging', `--load-extension=${copies[1]}`],
  })
  const targets = async () => (await browser.cdp.send('Target.getTargets')).targetInfos
  try {
    const copyB = await waitFor(async () => (await browser.cdp.send('Extensions.getExtensions')).extensions.find(extension => extension.name === 'LC-time'), 'copy B installed by startup flags')
    const copyA = await browser.cdp.send('Extensions.loadUnpacked', { path: copies[0] })
    const ids = [copyA.id, copyB.id]
    if (fixed) {
      assert.equal(ids[0], 'oljjkibnelfpnchehckndlpbflhfooce')
      assert.equal(ids[1], ids[0], 'both unpacked directories must produce the pinned production identity')
    } else assert.notEqual(ids[0], ids[1])
    const first = (await targets()).find(target => target.type === 'page' && target.url === 'about:blank')
    assert.ok(first)
    const handoff = spawn(process.env.LC_CHROME_BINARY, [
      `--user-data-dir=${browser.dir}`, '--profile-directory=Profile 1',
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' })
    await waitFor(() => handoff.exitCode !== null || handoff.signalCode !== null, 'second-profile handoff')
    const second = await waitFor(async () => (await targets()).find(target =>
      target.type === 'page' && target.url === 'about:blank' && target.browserContextId !== first.browserContextId), 'second profile')
    const profiles = []
    for (const [index, target] of [first, second].entries()) {
      const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      const evaluate = async expression => {
        try { return await browser.cdp.evaluate(sessionId, expression) }
        catch (error) { throw new Error(`${fixed ? 'fixed identity' : 'different IDs'}, profile ${index}, ${expression.slice(0, 100)}: ${error.message}`, { cause: error }) }
      }
      await browser.cdp.send('Page.navigate', { url: `chrome-extension://${ids[index]}/identity-probe.html` }, sessionId)
      await waitFor(() => evaluate("typeof chrome !== 'undefined' && !!chrome.runtime?.id && Array.isArray(globalThis.events)"), 'extension probe page')
      assert.equal(await evaluate('chrome.runtime.id'), ids[index])
      assert.equal(await evaluate('globalThis.copyIndex'), index, 'each profile must actually run its own unpacked directory')
      const tab = await evaluate("chrome.tabs.create({url:'about:blank',active:false})")
      profiles.push({ evaluate, tab, id: ids[index], context: target.browserContextId })
    }
    for (const profile of profiles) await profile.evaluate(`chrome.debugger.attach({tabId:${profile.tab.id}},'1.3')`)
    if (!fixed) await waitFor(() => profiles[1].evaluate("events.some(event=>event.reason==='canceled_by_user')"), 'automatic detach without any Cancel action')
    else await sleep(200)
    const states = []
    for (const profile of profiles) {
      states.push(await profile.evaluate(`(async()=>{
        try {
          await chrome.debugger.sendCommand({tabId:${profile.tab.id}}, 'Emulation.setTimezoneOverride', {timezoneId:'America/Los_Angeles'});
          const read = await chrome.debugger.sendCommand({tabId:${profile.tab.id}}, 'Runtime.evaluate', {expression:'Intl.DateTimeFormat().resolvedOptions().timeZone', returnByValue:true});
          return {owned:true,timezone:read.result.value,events};
        } catch(error) { return {owned:false,error:error.message,events}; }
      })()`))
    }
    const version = await browser.cdp.send('Browser.getVersion')
    const result = { fixed, browser: version.product, copies, profiles: profiles.map(({ id, context }) => ({ id, context })), states }
    if (fixed) {
      assert.ok(states.every(state => state.owned && state.timezone === 'America/Los_Angeles' && state.events.length === 0), JSON.stringify(result, null, 2))
      console.log(`PASS ${version.product}: both copied directories have the fixed ID and both profile sessions stay connected`)
    } else {
      assert.equal(states[0].owned, true)
      assert.equal(states[1].owned, false)
      assert.ok(states[1].events.some(event => event.reason === 'canceled_by_user'))
      console.log(`PASS ${version.product}: same-name/different-ID copies reproduce automatic canceled_by_user without clicking Cancel`)
    }
    return result
  } finally { await browser.close() }
}

;(async () => {
  assert.ok(manifest.key, 'the production manifest must keep its public identity key')
  const results = [await scenario(false), await scenario(true)]
  await writeFile(await resultPath(`identity-${results[0].browser.split('/')[1]}.json`), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
