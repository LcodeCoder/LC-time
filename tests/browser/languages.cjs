const {resultPath}=require('./harness.cjs')
const {launch,waitFor}=require('./harness.cjs')
const http=require('node:http')
const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const reports=new Map()
const documentHeaders=[]
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost')
 if(url.pathname==='/report') {reports.set('page',{...JSON.parse(url.searchParams.get('data')),header:req.headers['accept-language'],ch:req.headers['sec-ch-ua'],uaHeader:req.headers['user-agent']});res.end('ok');return}
 documentHeaders.push(req.headers['accept-language']);res.setHeader('content-type','text/html');res.setHeader('cache-control','no-store')
 res.end(`<!doctype html><title>Language and font regression</title><script>let highEntropy;navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64','formFactors','uaFullVersion']).then(value=>highEntropy=value);const initial={zone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale};addEventListener('DOMContentLoaded',()=>{const report=()=>fetch('/report?data='+encodeURIComponent(JSON.stringify({initial,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,languages:navigator.languages,locale:Intl.DateTimeFormat().resolvedOptions().locale,ua:navigator.userAgent,brands:navigator.userAgentData?.brands,highEntropy,font:getComputedStyle(document.body).fontFamily,siteFont:getComputedStyle(document.querySelector('span')).fontFamily,time:Date.now()})));report();setInterval(report,150)})</script><p>Default font ABC abc 日本語 中文</p><span style="font-family:'Courier New'">Site font remains intact</span>`)
})
;(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;const b=await launch('language-fonts')
 try {
  const originalFont=await b.eval(`chrome.fontSettings.getFont({genericFamily:'standard'})`)
  const page=await b.eval(`chrome.tabs.create({url:${JSON.stringify(base)},active:true})`)
  await waitFor(()=>reports.get('page')?.highEntropy,'default report');const original={...reports.get('page')}
  await b.eval(`chrome.tabs.create({url:chrome.runtime.getURL('html/popup.html'),active:false})`)
  const target=await waitFor(async()=>(await b.cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/html/popup.html')),'popup')
  const {sessionId}=await b.cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  const evaluate=expr=>b.cdp.evaluate(sessionId,expr)
  await waitFor(()=>evaluate(`!!document.querySelector('#locationsOptGroup')?.children.length`),'popup ready')
  const choose=async value=>evaluate(`(()=>{const el=document.querySelector('#configuration');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const refresh=async()=>{
   const result=await evaluate(`chrome.runtime.sendMessage({type:'reload-with-settings',tabId:${page.id}})`)
   assert.equal(result.ok,true,JSON.stringify(result));return result
  }
  for(const [zone,language] of [['America/Los_Angeles','en-US'],['Asia/Tokyo','ja-JP'],['Asia/Shanghai','zh-CN']]){
   await choose('zone:'+zone)
   await waitFor(()=>reports.get('page')?.zone===zone && reports.get('page')?.language===language,'time and language '+language)
   const state=await refresh()
   await waitFor(()=>reports.get('page')?.initial.language===language && reports.get('page')?.initial.zone===zone && reports.get('page')?.highEntropy,'first script '+language)
   const report=reports.get('page')
   assert.equal(report.locale,language)
   assert.ok(report.header.startsWith(language),report.header)
   assert.ok(documentHeaders.at(-1).startsWith(language),documentHeaders.at(-1))
   assert.equal(report.ua,original.ua)
   assert.equal(report.uaHeader,original.uaHeader)
   assert.deepEqual(report.brands,original.brands)
   assert.deepEqual(report.highEntropy,original.highEntropy)
   assert.equal(report.ch,original.ch)
   assert.equal(report.siteFont,original.siteFont)
   const font=await b.eval(`chrome.fontSettings.getFont({genericFamily:'standard'})`)
   assert.equal(font.fontId,state.font)
   assert.ok(report.font.includes(font.fontId),JSON.stringify({reportFont:report.font,font:font.fontId}))
   console.log('PASS',JSON.stringify({zone,language,header:report.header,font:font.fontId,rendered:report.font,uaPreserved:true}))
  }
  await evaluate(`(()=>{const el=document.querySelector('#fontMode');el.value='browser';el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await waitFor(async()=>(await b.eval(`chrome.fontSettings.getFont({genericFamily:'standard'})`)).fontId===originalFont.fontId,'font restore')
  assert.equal(reports.get('page').language,'zh-CN')
  console.log('PASS: disabling font sync restores original font without disabling timezone or language')
  await choose('browserDefault')
  await waitFor(()=>reports.get('page').zone===original.zone && reports.get('page').language===original.language,'all defaults restored')
  await refresh()
  await waitFor(()=>reports.get('page').header===original.header,'original language header')
  assert.equal((await b.eval(`chrome.fontSettings.getFont({genericFamily:'standard'})`)).fontId,originalFont.fontId)
  console.log('PASS: browser default restores time zone, navigator language, request language and original font')
  await fs.writeFile(await resultPath('language-results.json'),JSON.stringify({original,final:reports.get('page'),documentHeaders},null,2))
 }finally{await b.close();server.closeAllConnections();server.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
