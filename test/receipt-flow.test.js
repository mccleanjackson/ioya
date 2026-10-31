const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const fixtureText = 'MAPLE CAFE\nLatte 4.50\nBagel 3.25\nTax 0.62\nTOTAL 8.37';
const photo = {type:'image/png', size:1000};
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise,resolve}; };

function harness(createWorker){
  const timers = new Map(); let timerId = 0;
  const worker = {terminated:0, setParameters:async()=>{}, recognize:async()=>({data:{text:fixtureText}}), terminate:async function(){this.terminated++;}};
  const context = {
    window:{Tesseract:{createWorker:createWorker || (async()=>worker)}},
    document:{getElementById:()=>({}),addEventListener:()=>{},createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}})})},
    localStorage:{getItem:()=>null,setItem(){}},
    URL:{createObjectURL:()=> 'blob:test-photo',revokeObjectURL(){}},
    Image:class {naturalWidth=900;naturalHeight=1000;async decode(){}},
    setTimeout:f=>{const id=++timerId;timers.set(id,f);return id;},clearTimeout:id=>timers.delete(id),
    console
  };
  // Keep production scanning logic, replace only DOM rendering and app startup.
  const instrumented=script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {runScan,cancelScan,go,S,ui,A}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented,context);
  const api=context.api;
  api.S.draft.at='review';
  api.S.draft.merchant='Previous draft';
  api.S.draft.items=[{id:'old',name:'Existing item',price:123}];
  return {api,worker,timers};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

test('successful OCR creates editable candidates, releases worker and keeps no sample data', async()=>{
  const {api,worker,timers}=harness();
  await api.runScan(photo);
  assert.equal(api.S.view,'review');
  assert.equal(api.S.draft.merchant,'MAPLE CAFE');
  assert.equal(api.S.draft.items.length,2);
  assert.equal(api.S.draft.printed,837);
  assert.equal(api.S.draft.fromSample,false);
  assert.equal(api.S.draft.fromScan,true);
  assert.equal(worker.terminated,1);
  assert.equal(timers.size,0);
});

test('cancel during worker initialization preserves previous draft and terminates late worker',async()=>{
  const ready=deferred();
  const {api,worker}=harness(()=>ready.promise);
  const draft=api.S.draft, running=api.runScan(photo);
  await flush(); api.A.cancelScan(); ready.resolve(worker); await running;
  assert.equal(api.S.view,'scan');
  assert.equal(api.S.draft,draft);
  assert.equal(api.S.draft.at,'review');
  assert.equal(worker.terminated,1);
});

test('cancel during recognition ignores a late result and preserves draft',async()=>{
  const result=deferred(), {api,worker}=harness();
  worker.recognize=()=>result.promise;
  const draft=api.S.draft,running=api.runScan(photo);
  await flush(); api.A.cancelScan(); result.resolve({data:{text:fixtureText}}); await running;
  assert.equal(api.S.draft,draft);
  assert.equal(api.S.view,'scan');
  assert.equal(worker.terminated,1);
});

test('unreadable photo and OCR failure preserve the draft and offer manual entry',async()=>{
  for(const mode of ['blank','failure']){
    const {api,worker}=harness(),draft=api.S.draft;
    worker.recognize=async()=>{if(mode==='failure')throw Error('Reader unavailable');return {data:{text:''}};};
    await api.runScan(photo);
    assert.equal(api.S.view,'scan'); assert.equal(api.S.draft,draft);
    assert.match(api.ui.scanError,mode==='blank'?/No priced items/:/Reader unavailable/);
    assert.equal(api.ui.photo,null);
    api.A.manual(); assert.equal(api.S.view,'review');
    assert.equal(api.S.draft.items[0].name,'');
  }
});

test('reader startup failure and scan timeout recover without replacing draft',async()=>{
  const unavailable=harness(async()=>{throw Error('Download failed');});
  const original=unavailable.api.S.draft;
  await unavailable.api.runScan(photo);
  assert.equal(unavailable.api.S.draft,original);
  assert.match(unavailable.api.ui.scanError,/Download failed/);

  const ready=deferred(), {api,worker,timers}=harness(()=>ready.promise);
  const draft=api.S.draft,running=api.runScan(photo);await flush();
  [...timers.values()][0]();ready.resolve(worker);await running;
  assert.equal(api.S.draft,draft);assert.equal(api.S.view,'scan');
  assert.match(api.ui.scanError,/too long/);assert.equal(worker.terminated,1);
});

test('rejects unsupported or oversized files before loading OCR',async()=>{
  const {api,worker}=harness(),draft=api.S.draft;
  for(const file of [{type:'application/pdf',size:500},{type:'image/jpeg',size:21*1024*1024}]){
    await api.runScan(file);assert.equal(api.S.draft,draft);assert.match(api.ui.scanError,/smaller than 20 MB/);
  }
  assert.equal(worker.terminated,0);
});
