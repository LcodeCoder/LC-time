const {launch,waitFor,reports,server,resultPath}=require('./harness.cjs')
const assert=require('node:assert/strict');const fs=require('node:fs/promises')
;(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/?id=restart`
 let browser=await launch('restart')
 try {
  await browser.eval(`chrome.storage.local.set({configuration:'zone:Asia/Tokyo',timezone:'Asia/Tokyo',locale:'ja-JP',fontMode:'auto'})`)
  await browser.eval(`chrome.tabs.create({url:${JSON.stringify(base)}})`)
  await waitFor(()=>reports.get('restart')?.zone==='Asia/Tokyo','initial saved setting')
  const dir=browser.dir;await browser.close();reports.clear()
  browser=await launch('restart',{dir})
  const saved=await browser.eval('chrome.storage.local.get(["configuration","timezone","locale","fontMode"])')
  assert.equal(saved.timezone,'Asia/Tokyo');assert.equal(saved.locale,'ja-JP')
  const tab=await browser.eval(`chrome.tabs.create({url:${JSON.stringify(base)}})`)
  await waitFor(()=>reports.get('restart')?.zone==='Asia/Tokyo','automatic application after restart')
  await waitFor(async()=>{const result=(await browser.eval(`chrome.storage.session.get('lc-time-tab:${tab.id}')`))['lc-time-tab:'+tab.id];return result?.ok&&result.locale==='ja-JP'},'language verified after restart')
  await fs.writeFile(await resultPath('restart-results.json'),JSON.stringify({saved,automaticallyApplied:true},null,2))
  console.log('PASS saved timezone, language and fonts survive a full browser restart without reconfiguration')
 } finally {await browser.close();server.closeAllConnections();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
