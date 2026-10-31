const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function app(saved){
  const context={window:{},document:{getElementById:()=>({}),addEventListener(){}},localStorage:{getItem:()=>saved?JSON.stringify(saved):null,setItem(){}},console};
  vm.runInNewContext(script.replace("if (!V[S.view]","render=()=>{};globalThis.api={newDraft,normalizeTipDraft,tipState,calc,S,A,sendPlan,LIVE};return;\nif (!V[S.view]"),context);
  return context.api;
}
function receipt(api){
  const d=api.newDraft();
  Object.assign(d,{items:[{id:'a',name:'Meal A',price:550},{id:'b',name:'Meal B',price:450}],tax:80,fees:20,printed:1100,
    people:[{id:'me',name:'You',me:true},{id:'friend',name:'Friend',method:'venmo',venmo:'@test-only'}],assign:{a:['me'],b:['friend']}});
  api.S.draft=d;return d;
}

test('a new receipt has no selected tip and adds no automatic 18 percent',()=>{
  const api=app(),d=receipt(api),t=api.tipState(d),c=api.calc(d);
  assert.equal(d.tipMode,null);assert.equal(d.tipPct,null);
  assert.equal(t.chosen,false);assert.equal(c.tip,0);assert.equal(c.grand,1100);
});

test('a custom dollar tip is allocated proportionally with every cent accounted for',()=>{
  const api=app(),d=receipt(api);
  Object.assign(d,{tipMode:'amount',tipInput:'1.23'});
  const c=api.calc(d);
  assert.equal(c.tip,123);assert.equal(c.grand,1223);
  assert.equal(c.totals.me,673);assert.equal(c.totals.friend,550);
  assert.equal(c.sumTotals,c.grand);assert.equal(c.totalsOff,false);
});

test('a one-cent custom tip split three ways is not lost or duplicated',()=>{
  const api=app(),d=receipt(api);
  Object.assign(d,{items:[{id:'x',name:'Shared',price:3}],tax:0,fees:0,printed:3,
    people:[{id:'a'},{id:'b'},{id:'c'}],assign:{x:['a','b','c']},tipMode:'amount',tipInput:'.01'});
  const c=api.calc(d);
  assert.equal(c.tip,1);assert.equal(c.sumTotals,4);
  assert.equal(c.totals.a,2);assert.equal(c.totals.b,1);assert.equal(c.totals.c,1);
});

test('percentage and No tip replace a custom amount instead of adding to it',()=>{
  const api=app(),d=receipt(api);
  Object.assign(d,{tipMode:'amount',tipInput:'5.00'});
  api.A.tip({p:'18'});
  assert.equal(d.tipInput,'');assert.equal(api.calc(d).tip,180);
  d.items[0].price=1050;
  assert.equal(api.calc(d).tip,270);
  api.A.tip({p:'0'});
  assert.equal(api.tipState(d).chosen,true);assert.equal(api.calc(d).tip,0);
});

test('custom dollar tips stay fixed when item prices change',()=>{
  const api=app(),d=receipt(api);Object.assign(d,{tipMode:'amount',tipInput:'2.50'});
  d.items[0].price=1050;
  assert.equal(api.calc(d).tip,250);
});

test('invalid custom amounts block advancing and sending instead of being silently charged',()=>{
  const api=app(),d=receipt(api);
  for(const value of ['-2.00','abc','1.234','1e3','Infinity','99999999999999999999']){
    Object.assign(d,{tipMode:'amount',tipInput:value});
    assert.equal(api.calc(d).tipValid,false,value);
    assert.equal(api.sendPlan().globalBlock,true,value);
    assert.match(api.LIVE.revnext(),/disabled/,value);
  }
});

test('zero and normal decimal entry forms are valid custom amounts',()=>{
  const api=app(),d=receipt(api);
  for(const [value,cents] of [['0',0],['.50',50],['2.',200],['12.34',1234],['0.29',29]]){
    Object.assign(d,{tipMode:'amount',tipInput:value});
    const t=api.tipState(d);assert.equal(t.valid,true,value);assert.equal(t.cents,cents,value);
  }
});

test('older unsubmitted drafts keep receipt work while resetting the old default tip',()=>{
  const first=app(),old=receipt(first);delete old.tipMode;delete old.tipInput;old.tipPct=18;
  const restored=app({view:'review',draft:old}).S.draft;
  assert.equal(restored.tipMode,null);assert.equal(restored.tipPct,null);
  assert.equal(JSON.stringify(restored.items),JSON.stringify(old.items));
  assert.equal(JSON.stringify(restored.assign),JSON.stringify(old.assign));
});

test('an explicit custom tip survives a draft refresh',()=>{
  const first=app(),d=receipt(first);Object.assign(d,{tipMode:'amount',tipInput:'3.25'});
  const restored=app({view:'review',draft:d});
  assert.equal(restored.tipState(restored.S.draft).cents,325);
});
