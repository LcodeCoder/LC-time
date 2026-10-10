const { spawn } = require('node:child_process')
const { mkdtemp, readFile, mkdir, rm } = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const assert = require('node:assert/strict')
const chromePath=process.env.LC_CHROME_BINARY
if (!chromePath) throw Error('Set LC_CHROME_BINARY to the Chrome for Testing executable.')
const extensionPath=path.resolve(__dirname,'../../build')
const resultsDir=process.env.LC_TEST_RESULTS_DIR||path.join(require('node:os').tmpdir(),'lc-time-test-results')
const resultPath=async name=>{await mkdir(resultsDir,{recursive:true});return path.join(resultsDir,name)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
class CDP {
 constructor(ws) {this.ws=ws;this.id=0;this.pending=new Map(); ws.addEventListener('message',({data})=>{const m=JSON.parse(data); if(m.id) {const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}})}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});return new CDP(ws)}
 send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP timeout ${method}`))},15000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}
 async evaluate(sessionId,expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
}
async function waitFor(fn,label,timeout=12000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await sleep(80)}throw Error(`Timeout: ${label}`)}
async function launch(label, options={}){
 const dir=options.dir||await mkdtemp(path.join(require('node:os').tmpdir(),`lc-time-${label}-`))
 await rm(path.join(dir,'DevToolsActivePort'),{force:true})
 const proc=spawn(chromePath,[`--user-data-dir=${dir}`,...(options.headed?[]:['--headless=new']),...(options.args||[]),'--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'about:blank'],{stdio:['ignore','ignore',require('node:fs').openSync(path.join(dir,'test-chrome.log'),'a')],env:{...process.env,TZ:'Asia/Shanghai'}})
 const port=await waitFor(async()=>{try{return (await readFile(path.join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0]}catch{return false}},'Chrome startup')
 const version=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();const cdp=await CDP.connect(version.webSocketDebuggerUrl)
 const worker=await waitFor(async()=>(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/js/background.js')),'extension worker')
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:worker.targetId,flatten:true})
 await waitFor(()=>cdp.evaluate(sessionId,"typeof chrome !== 'undefined' && !!chrome.runtime?.id"),'extension API initialization')
 return {label,dir,port,proc,cdp,sessionId,extensionId:new URL(worker.url).host,eval:exp=>cdp.evaluate(sessionId,exp),close:async()=>{await cdp.send('Browser.close').catch(()=>{});cdp.ws.close();await waitFor(()=>proc.exitCode!==null||proc.signalCode!==null,'Chrome exit',5000).catch(()=>proc.kill())}}
}
const reports=new Map()
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost')
 if(url.pathname==='/report'){reports.set(url.searchParams.get('id'),JSON.parse(url.searchParams.get('data')));res.end('ok');return}
 res.setHeader('content-type','text/html');res.setHeader('cache-control','no-store')
 const id=url.searchParams.get('id')
 res.end(`<!doctype html><title>Timezone test</title><script>const initial=Intl.DateTimeFormat().resolvedOptions().timeZone;const report=()=>fetch('/report?id=${id}&data='+encodeURIComponent(JSON.stringify({initial,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset(),time:Date.now()})));report();setInterval(report,150)</script><h1>Timezone regression</h1>`)
})
module.exports={CDP,launch,waitFor,sleep,reports,server,resultPath}
