const {resultPath}=require('./harness.cjs')
const {launch,waitFor,sleep}=require('./harness.cjs')
const http=require('node:http');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const reports=new Map();const initial=new Map()
const snapshot=`({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:navigator.languages,winter:new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),summer:new Date('2026-07-15T12:00:00Z').getTimezoneOffset(),nativeDate:Function.prototype.toString.call(Date),nativeIntl:Function.prototype.toString.call(Intl.DateTimeFormat)})`
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('cache-control','no-store')
 if(url.pathname==='/report'){const data=JSON.parse(url.searchParams.get('data'));data.header=req.headers['accept-language'];const id=url.searchParams.get('id');reports.set(id,data);if(!initial.has(id))initial.set(id,data);res.end('ok');return}
 if(url.pathname.endsWith('.js')){
  res.setHeader('content-type','application/javascript');const report=`fetch('/report?id=${url.pathname}&data='+encodeURIComponent(JSON.stringify(${snapshot})))`
  if(url.pathname==='/service.js')res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(${report}));`)
  else if(url.pathname==='/shared.js')res.end(`onconnect=e=>{${report};e.ports[0].postMessage('done')};setInterval(()=>${report},250)`)
  else res.end(`${report};setInterval(()=>${report},250);${url.pathname==='/dedicated.js'?"new Worker('/nested-worker.js')":''}`)
  return
 }
 const port=server.address().port;const id=url.searchParams.get('id')||'main';const isMain=url.pathname==='/'
 res.setHeader('content-type','text/html');res.end(`<!doctype html><script>function report(){fetch('/report?id=${id}&data='+encodeURIComponent(JSON.stringify(${snapshot})))}report();setInterval(report,250)</script>${id==='cross'?`<iframe src='http://127.0.0.1:${port}/frame?id=nested'></iframe>`:''}${isMain?`<iframe src='/frame?id=same'></iframe><iframe src='http://localhost:${port}/frame?id=cross'></iframe><script>new Worker('/dedicated.js');window.shared=new SharedWorker('/shared.js');window.shared.port.start();navigator.serviceWorker.register('/service.js').then(()=>navigator.serviceWorker.ready).then(r=>{r.active.postMessage('report');setInterval(()=>r.active.postMessage('report'),250)});</script>`:''}`)
})
;(async()=>{
 await new Promise(r=>server.listen(0,r));const base=`http://127.0.0.1:${server.address().port}`;const b=await launch('contexts-verify');const results=[]
 const expectedIds=['main','same','cross','nested','/dedicated.js','/nested-worker.js','/shared.js','/service.js']
 try {
  const tab=await b.eval(`chrome.tabs.create({url:${JSON.stringify(base)},active:true})`)
  await waitFor(()=>expectedIds.every(id=>reports.has(id)),'all eight contexts')
  await b.eval(`chrome.tabs.create({url:chrome.runtime.getURL('html/popup.html'),active:false})`)
  const target=await waitFor(async()=>(await b.cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/html/popup.html')),'popup')
  const {sessionId}=await b.cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});const evaluate=e=>b.cdp.evaluate(sessionId,e)
  const native=structuredClone(reports.get('main'))
  for(const [zone,locale,winter,summer] of [['America/Los_Angeles','en-US',480,420],['Asia/Tokyo','ja-JP',-540,-540],['Asia/Shanghai','zh-CN',-480,-480]]){
   await b.eval(`chrome.storage.local.set({configuration:${JSON.stringify('zone:'+zone)},timezone:${JSON.stringify(zone)},fontMode:'auto'})`)
   await waitFor(()=>expectedIds.every(id=>{const r=reports.get(id);return r?.zone===zone&&r.language===locale&&r.locale===locale}),'live consistency '+zone)
   await waitFor(async()=>{const s=await b.eval('chrome.storage.session.get(null)');const coverage=s['lc-time-coverage:'+tab.id];return s['lc-time-tab:'+tab.id]?.ok&&coverage?.pending===0&&coverage.errors.length===0},'verified coverage '+zone)
   reports.clear();initial.clear()
   const r=await evaluate(`chrome.runtime.sendMessage({type:'reload-with-settings',tabId:${tab.id}})`);assert.equal(r.ok,true,JSON.stringify(r))
   await waitFor(()=>expectedIds.every(id=>reports.has(id)),'reloaded contexts '+zone)
   for(const id of expectedIds){for(const values of [initial.get(id),reports.get(id)]){
    assert.equal(values.zone,zone,id);assert.equal(values.language,locale,id);assert.equal(values.locale,locale,id);assert.deepEqual(values.languages,[locale,locale.split('-')[0]],id)
    assert.equal(values.winter,winter,id);assert.equal(values.summer,summer,id);assert.equal(values.header,`${locale},${locale.split('-')[0]};q=0.9`,id)
    assert.equal(values.nativeDate,native.nativeDate,id);assert.equal(values.nativeIntl,native.nativeIntl,id)
   }}
   const coverage=await b.eval(`chrome.storage.session.get('lc-time-coverage:${tab.id}')`)
   results.push({zone,contexts:expectedIds.length,firstScript:true,languageHeaders:true,nativeFunctions:true,coverage});console.log('PASS',zone,JSON.stringify(coverage))
  }
  await b.eval(`chrome.storage.local.set({configuration:'browserDefault'})`)
  await waitFor(async()=>(await b.eval(`chrome.storage.session.get('lc-time-tab:${tab.id}')`))['lc-time-tab:'+tab.id]?.code==='default','default applied')
  // A fresh document discards the same-process iframe's cached languages array.
  await evaluate(`chrome.runtime.sendMessage({type:'reload-with-settings',tabId:${tab.id}})`)
  await waitFor(()=>expectedIds.every(id=>{const r=reports.get(id);return r.zone===native.zone&&r.language===native.language&&r.locale===native.locale&&JSON.stringify(r.languages)===JSON.stringify(native.languages)&&r.header===native.header}),'restored all contexts')
  const owned=await b.eval(`chrome.debugger.getTargets()`);assert.ok(!owned.filter(t=>t.url.startsWith(base)||t.url.startsWith('http://localhost:')).some(t=>t.attached),'all owned sessions released')
  results.push({restored:true,allSessionsReleased:true});await fs.writeFile(await resultPath('contexts-results.json'),JSON.stringify(results,null,2));console.log('PASS browser defaults and cleanup')
 }catch(e){console.log('REPORTS',JSON.stringify(Object.fromEntries(reports),null,2));console.log('STATUS',JSON.stringify(await b.eval('chrome.storage.session.get(null)'),null,2));throw e}
 finally{await b.close();server.closeAllConnections();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
