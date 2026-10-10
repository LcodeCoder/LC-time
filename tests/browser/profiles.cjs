const {resultPath}=require('./harness.cjs')
const {launch,waitFor,sleep,reports,server}=require('./harness.cjs')
const assert=require('node:assert/strict')
const {writeFile}=require('node:fs/promises')
const browsers=[]
const fieldChange=(id,value)=>`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`
async function popupFor(browser,activeTabId){
 await browser.eval(`chrome.tabs.update(${activeTabId},{active:true})`)
 const tab=await browser.eval("chrome.tabs.create({url:chrome.runtime.getURL('html/popup.html'),active:false})")
 const target=await waitFor(async()=>(await browser.cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/html/popup.html')),'popup target')
 const {sessionId}=await browser.cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})
 const evaluate=expr=>browser.cdp.evaluate(sessionId,expr)
 await waitFor(()=>evaluate("document.querySelector('#clockHours')?.textContent !== '--' && !!document.querySelector('#clockHours')"),'popup initialized')
 return {tab,evaluate,sessionId}
}
async function reportZone(id,zone){return waitFor(()=>reports.get(id)?.zone===zone,`${id} should read ${zone}`)}
;(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`
 try{
  for(const label of ['A','B']){
   const browser=await launch(label);browsers.push(browser)
   browser.main=await browser.eval(`chrome.tabs.create({url:${JSON.stringify(base+'/?id='+label)},active:true})`)
   browser.other=await browser.eval(`chrome.tabs.create({url:${JSON.stringify(base+'/?id='+label+'2')},active:false})`)
   await reportZone(label,'Asia/Shanghai');await reportZone(label+'2','Asia/Shanghai')
   browser.popup=await popupFor(browser,browser.main.id)
   await browser.popup.evaluate(`window.fetch=async()=>new Response(JSON.stringify({status:'success',timezone:'America/Los_Angeles',countryCode:'US',lat:34.05,lon:-118.24,query:'same-test-ip'}),{status:200,headers:{'Content-Type':'application/json'}})`)
   await browser.popup.evaluate("document.querySelector('#ipTimezoneToggle').click()")
  }
  for(const browser of browsers){
   await reportZone(browser.label,'America/Los_Angeles');await reportZone(browser.label+'2','America/Los_Angeles')
   await waitFor(()=>browser.popup.evaluate("document.querySelector('#saveStatus').dataset.state==='saved'"),'applied success status')
   const title=await browser.eval('chrome.action.getTitle({})');assert.ok(title.includes('America/Los_Angeles'))
  }
  console.log('PASS: both independent profiles enable the same IP time zone through the actual popup; all four pre-existing pages update')
  const b=browsers[1]
  await b.popup.evaluate("document.querySelector('#reloadButton').click()")
  await waitFor(()=>reports.get('B')?.initial==='America/Los_Angeles','B first script after refresh')
  await reportZone('B2','America/Los_Angeles');await reportZone('A','America/Los_Angeles')
  console.log('PASS: popup refresh retains sessions in both profiles; refreshed page sees target time zone in its first script')
  const earlier=reports.get('B').time
  await b.popup.evaluate("document.querySelector('#reloadButton').click()")
  await waitFor(()=>reports.get('B')?.time>earlier,'second refresh')
  await sleep(300)
  assert.equal(reports.get('B2').zone,'America/Los_Angeles')
  console.log('PASS: repeated save/refresh no longer resets sibling pages')

  // Another debugger target must not be mistaken for a successfully applied tab.
  const foreign=await b.eval(`chrome.tabs.create({url:${JSON.stringify(base+'/?id=foreign')},active:false})`)
  await reportZone('foreign','America/Los_Angeles')
  await b.eval(`chrome.debugger.detach({tabId:${foreign.id}})`)
  const foreignTarget=await waitFor(async()=>(await b.cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.includes('id=foreign')),'foreign target')
  const foreignSession=await b.cdp.send('Target.attachToTarget',{targetId:foreignTarget.targetId,flatten:true})
  // CDP permits several clients in some versions; force a different timezone from
  // that client to exercise actual override ownership conflicts.
  await b.cdp.send('Emulation.setTimezoneOverride',{timezoneId:'Europe/London'},foreignSession.sessionId)
  const result=await b.popup.evaluate(`chrome.runtime.sendMessage({type:'reload-with-settings',tabId:${foreign.id}})`)
  assert.equal(result.ok,false)
  assert.match(result.message,/占用|覆盖/)
  await b.cdp.send('Target.detachFromTarget',{sessionId:foreignSession.sessionId})
  const recovered=await b.popup.evaluate(`chrome.runtime.sendMessage({type:'reload-with-settings',tabId:${foreign.id}})`)
  assert.equal(recovered.ok,true)
  await waitFor(()=>reports.get('foreign')?.initial==='America/Los_Angeles','recovery after debugger conflict')
  console.log('PASS: conflicting debugger/override reports an actionable failure; explicit refresh recovers after conflict closes')

  // Disconnection cannot silently turn a saved value into an "applied" success.
  await b.eval(`chrome.debugger.detach({tabId:${b.main.id}})`)
  const recovery=await b.popup.evaluate(`chrome.runtime.sendMessage({type:'check-current-tab',tabId:${b.main.id}})`)
  assert.equal(recovery.ok,true)
  await reportZone('B','America/Los_Angeles')
  console.log('PASS: rechecking a silently lost session restores the actual page instead of trusting stale state')

  await b.popup.evaluate("document.querySelector('#ipTimezoneToggle').click()")
  await reportZone('B','Asia/Shanghai');await reportZone('B2','Asia/Shanghai')
  assert.equal(reports.get('A').zone,'America/Los_Angeles')
  console.log('PASS: switching off IP mode restores defaults only in that profile')

  await b.popup.evaluate(fieldChange('configuration','zone:Asia/Tokyo'))
  await reportZone('B','Asia/Tokyo');await reportZone('B2','Asia/Tokyo')
  await b.popup.evaluate(fieldChange('configuration','zone:Europe/Berlin'))
  await b.popup.evaluate(fieldChange('configuration','zone:America/Los_Angeles'))
  await reportZone('B','America/Los_Angeles');await reportZone('B2','America/Los_Angeles')
  console.log('PASS: rapid changes settle on the latest saved time zone')

  const statuses=await b.eval('chrome.storage.session.get(null)')
  console.log('Current application state:',JSON.stringify(statuses,null,2))
  await writeFile(await resultPath('results.json'),JSON.stringify({reports:Object.fromEntries(reports),statuses},null,2))
 }finally{for(const browser of browsers)await browser.close();server.closeAllConnections();server.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
