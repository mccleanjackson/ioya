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
  const instrumented=script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {runScan,cancelScan,go,S,ui,A,V}; return;\nif (!V[S.view]");
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

test('scanned product codes are shortened without changing amounts; originals are transient and restorable',async()=>{
  const {api,worker}=harness();
  worker.recognize=async()=>({data:{text:'MARKET\n000123456 CHKN BRST BNLS 4.50\nV8 12OZ 3.25\nTax 0.62\nTOTAL 8.37'}});
  await api.runScan(photo);
  const item=api.S.draft.items[0];
  assert.equal(item.name,'Chicken Breast Boneless');assert.equal(item.price,450);
  assert.equal(api.S.draft.items[1].name,'V8 12OZ');assert.equal(api.S.draft.printed,837);
  assert.equal(api.ui.originalNames[item.id],'000123456 CHKN BRST BNLS');
  assert.equal(JSON.stringify(api.S.draft).includes('000123456'),false);
  api.A.restoreName({id:item.id});assert.equal(item.name,'000123456 CHKN BRST BNLS');
  assert.equal(api.ui.originalNames[item.id],undefined);
  api.A.shortenNames();assert.equal(item.name,'Chicken Breast Boneless');assert.equal(item.price,450);
});

test('name cleanup retains meaningful short numbers and leaves unknown codes unchanged',async()=>{
  const {api}=harness();
  const cases=[['000999999 2% MILK','2% MILK'],['V8 12OZ','V8 12OZ'],['7UP','7UP'],['A1 SAUCE','A1 SAUCE'],['12345ABC CHKN SNDWCH','Chicken Sandwich'],['123456789','123456789']];
  for(const [original,expected] of cases){
    api.S.draft.items=[{id:'item',name:original,price:321}];api.A.shortenNames();
    assert.equal(api.S.draft.items[0].name,expected);assert.equal(api.S.draft.items[0].price,321);
  }
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
    assert.match(api.ui.scanError,mode==='blank'?/No readable text/:/Reader unavailable/);
    assert.equal(api.ui.photo,null);
    api.A.manual(); assert.equal(api.S.view,'review');
    assert.equal(api.S.draft.items[0].name,'');
  }
});

test('retries an alternate receipt layout when the first read finds no prices',async()=>{
  const {api,worker}=harness();let calls=0;const params=[];
  worker.setParameters=async p=>params.push(p);
  worker.recognize=async(_image,options)=>{
    calls++;
    if(calls===2)assert.equal(options.rotateAuto,true);
    return {data:{text:calls===1?'MAPLE CAFE\nUnreadable prices':fixtureText}};
  };
  await api.runScan(photo);
  assert.equal(calls,2);assert.equal(params[1].tessedit_pageseg_mode,'4');
  assert.equal(api.S.view,'review');assert.equal(api.S.draft.printed,837);
  assert.equal(api.ui.scanText,'');assert.equal(worker.terminated,1);
});

test('a partial reading gets a shadow-tolerant retry and can recover a missing item',async()=>{
  const {api,worker}=harness();let calls=0;const params=[];
  worker.setParameters=async p=>params.push(p);
  worker.recognize=async()=>({data:{text:++calls===1?'MAPLE CAFE\nLatte 4.50\nTax 0.62\nTOTAL 8.37':fixtureText}});
  await api.runScan(photo);
  assert.equal(calls,2);assert.equal(params[1].thresholding_method,'2');
  assert.equal(api.S.draft.items.length,2);
  assert.equal(api.S.draft.items.reduce((sum,it)=>sum+it.price,0)+api.S.draft.tax,api.S.draft.printed);
});

test('keeps the better first reading when retry produces more lines but a worse total',async()=>{
  const {api,worker}=harness();let calls=0;
  worker.recognize=async()=>({data:{text:++calls===1?'CAFE\nTea 2.00\nTOTAL 3.00':'CAFE\nTea 2.00\nNoise 20.00\nTOTAL 3.00'}});
  await api.runScan(photo);
  assert.equal(calls,2);assert.equal(api.S.draft.items.length,1);
  assert.equal(api.S.draft.items[0].price,200);
});

test('a matching retry replaces a reading as a whole and preserves repeated products',async()=>{
  const {api,worker}=harness();let calls=0;
  worker.recognize=async()=>({data:{text:++calls===1?'CAFE\nTea 2.00\nTOTAL 4.00':'CAFE\nTea 2.00\nTea 2.00\nTOTAL 4.00'}});
  await api.runScan(photo);
  assert.equal(api.S.draft.items.length,2);
  assert.equal(api.S.draft.items.reduce((sum,it)=>sum+it.price,0),400);
});

test('finding some items without the printed total still triggers a second read',async()=>{
  const {api,worker}=harness();let calls=0;
  worker.recognize=async()=>({data:{text:++calls===1?'CAFE\nTea 2.00':'CAFE\nTea 2.00\nTOTAL 2.00'}});
  await api.runScan(photo);
  assert.equal(calls,2);assert.equal(api.S.draft.printed,200);
});

test('failed scan distinguishes parsed-text failure and safely displays temporary OCR text',async()=>{
  const {api,worker}=harness(),draft=api.S.draft;
  const text='</textarea><img src=x onerror=alert(1)>\nTEA PRICE UNREADABLE';
  worker.recognize=async()=>({data:{text}});
  await api.runScan(photo);
  assert.equal(api.S.draft,draft);assert.match(api.ui.scanError,/Some text was read/);
  assert.equal(api.ui.scanText,text);
  const output=api.V.scan();
  assert.ok(output.includes('&lt;/textarea&gt;&lt;img'));
  assert.ok(!output.includes(text));assert.ok(!JSON.stringify(api.S).includes(text));
  api.A.manual();assert.equal(api.ui.scanText,'');
});

test('cancelling the layout retry discards diagnostic text and ignores its late result',async()=>{
  const result=deferred(),started=deferred(),{api,worker}=harness();let calls=0;
  worker.recognize=async()=>{if(++calls===1)return {data:{text:'TEA price unreadable'}};started.resolve();return result.promise;};
  const draft=api.S.draft,running=api.runScan(photo);await started.promise;
  assert.equal(calls,2);api.A.cancelScan();
  result.resolve({data:{text:fixtureText}});await running;
  assert.equal(api.S.draft,draft);assert.equal(api.ui.scanText,'');
  assert.equal(api.S.view,'scan');assert.equal(worker.terminated,1);
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
