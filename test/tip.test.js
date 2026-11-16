const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/app.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function app(saved){
  const listeners={};
  const context={window:{},document:{getElementById:()=>({setAttribute(){}}),querySelectorAll:()=>[],
    addEventListener:(type,handler)=>(listeners[type] ||= []).push(handler)},localStorage:{getItem:()=>saved?JSON.stringify(saved):null,setItem(){}},console};
  vm.runInNewContext(script.replace("if (!V[S.view]","render=()=>{};globalThis.api={newDraft,normalizeTipDraft,tipState,calc,S,A,sendPlan,LIVE,V,sheetHTML};return;\nif (!V[S.view]"),context);
  return {...context.api,dispatch:(type,event)=>listeners[type].forEach(handler=>handler(event))};
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

test('two shared lines totaling $16 give four people exactly $4 each',()=>{
  const api=app(), d=receipt(api);
  const ids=['me','a','b','c'];
  Object.assign(d,{items:[{id:'x',price:798},{id:'y',price:802}],tax:0,fees:0,
    people:ids.map(id=>({id})),assign:{x:ids,y:ids}});
  const c=api.calc(d);
  assert.deepEqual(Object.values(c.totals),[400,400,400,400]);
  assert.deepEqual(Array.from(c.lines.me,line=>line.share),[200,200]);
  assert.equal(c.sumTotals,1600);
  d.assign.y=[...ids].reverse();
  assert.deepEqual(Object.values(api.calc(d).totals),[400,400,400,400]);
});

test('a saved percentage tip becomes an equivalent fixed dollar amount',()=>{
  const api=app(),d=receipt(api);
  Object.assign(d,{tipMode:'percent',tipPct:18,fees:0});
  const restored=app({view:'review',draft:d});
  assert.equal(restored.S.draft.tipInput,'1.80');
  restored.S.draft.items[0].price=1050;
  assert.equal(restored.calc(restored.S.draft).tip,180);
});

test('Enter formats review amounts and leaves an invalid tip visible',()=>{
  const api=app(),d=receipt(api);
  api.S.view='review';
  for (const [field,value,formatted] of [['iprice','5','5.00'],['tax','.8','0.80'],['tipamount','2','2.00'],['tipamount','1.234','1.234']]){
    const target={dataset:{in:field,id:'a'},value};
    api.dispatch('input',{target});
    api.dispatch('keydown',{key:'Enter',target,preventDefault(){}});
    assert.equal(target.value,formatted);
  }
  assert.equal(d.items[0].price,500);
  assert.equal(api.tipState(d).valid,false);
});

test('Next confirms the calculated split total before opening item matching',()=>{
  const api=app(),d=receipt(api);
  api.S.view='review';
  Object.assign(d,{printed:0,tipMode:'amount',tipInput:'2.50'});
  assert.match(api.LIVE.revnext(),/>Next</);
  assert.doesNotMatch(api.LIVE.revnext(),/disabled/);
  assert.doesNotMatch(api.V.review(),/data-in="printed"/);
  assert.equal(api.LIVE.reviewTotal(),'$13.50');
  api.A.reviewNext();
  assert.equal(api.S.view,'review');
  assert.match(api.sheetHTML(),/\$13\.50/);
  assert.match(api.sheetHTML(),/Yes, continue/);
  assert.match(api.sheetHTML(),/No, edit split/);
  api.A.close();
  assert.equal(api.S.view,'review');
  assert.equal(api.sheetHTML(),'');
  d.tax=100;
  api.A.reviewNext();
  assert.match(api.sheetHTML(),/\$13\.70/);
  api.A.confirmTotal();
  assert.equal(api.S.view,'assign');
});

test('custom dollar tips stay fixed when item prices change',()=>{
  const api=app(),d=receipt(api);Object.assign(d,{tipMode:'amount',tipInput:'2.50'});
  d.items[0].price=1050;
  assert.equal(api.calc(d).tip,250);
});

test('Next allows a partially entered receipt and reports the first missing name or price',()=>{
  const api=app(), d=receipt(api);
  api.S.view='review';
  d.items=[{id:'a',name:'',price:0},{id:'b',name:'',price:0}];
  assert.match(api.LIVE.revnext(),/disabled/);
  d.items[0].price=500;
  assert.doesNotMatch(api.LIVE.revnext(),/disabled/);
  api.A.reviewNext();
  assert.equal(api.sheetHTML(),'');
  assert.match(api.LIVE.itemnotice({}),/Item 1 needs a name/);
  d.items[0].name='  ';
  assert.match(api.LIVE.itemnotice({}),/Item 1 needs a name/);
  d.items[0].name='Meal';
  d.items[1].name='Drink';
  api.A.reviewNext();
  assert.equal(api.sheetHTML(),'');
  assert.match(api.LIVE.itemnotice({}),/Item 2 needs a valid price greater than \$0/);
  d.items[1].price=200;
  api.A.reviewNext();
  assert.match(api.sheetHTML(),/Does this match your receipt total/);
});

test('quantity edits update the split and survive refresh without changing the unit price',()=>{
  const api=app(), d=receipt(api);
  api.S.view='review';
  d.tax=d.fees=0;
  assert.match(api.V.review(),/>x 1<\/button>/);
  assert.match(api.V.review(),/id="tax"[^>]*value="" placeholder="0.00"/);

  const edit = (field,id,value) => api.dispatch('input',{target:{dataset:{in:field,id},value,setAttribute(){}}});
  edit('quantity','a','3');
  edit('tax',undefined,'');
  edit('tipamount',undefined,'0');
  assert.equal(api.LIVE.reviewTotal(),'$21.00');
  assert.match(api.V.review(),/id="p-a"[^>]*value="5.50"/);
  const restored = app({view:'review',draft:d});
  assert.match(restored.V.review(),/>x 3<\/button>/);
  assert.equal(restored.calc(restored.S.draft).totals.me,1650);

  edit('quantity','a','1.5');
  api.A.reviewNext();
  assert.equal(api.sheetHTML(),'');
  assert.match(api.LIVE.itemnotice({}),/positive whole number/);
  edit('quantity','a','3');
  edit('iprice','b','0');
  api.A.reviewNext();
  assert.equal(api.sheetHTML(),'');
  assert.match(api.LIVE.itemnotice({}),/valid price greater than \$0/);
  edit('iprice','b','4.50');
  assert.doesNotMatch(api.LIVE.revnext(),/disabled/);
});

test('invalid custom amounts block advancing and sending instead of being silently charged',()=>{
  const api=app(),d=receipt(api);
  api.S.view='review';
  for(const value of ['-2.00','abc','1.234','1e3','Infinity','99999999999999999999']){
    Object.assign(d,{tipMode:'amount',tipInput:value});
    assert.equal(api.calc(d).tipValid,false,value);
    assert.equal(api.sendPlan().globalBlock,true,value);
    api.A.reviewNext();
    assert.equal(api.sheetHTML(),'',value);
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
  const first=app(),old=receipt(first);delete old.tipMode;delete old.tipInput;old.tipPct=18;old.fees=0;
  const restored=app({view:'review',draft:old}).S.draft;
  assert.equal(restored.tipMode,null);assert.equal(restored.tipPct,null);
  assert.equal(JSON.stringify(restored.items),JSON.stringify(old.items));
  assert.equal(JSON.stringify(restored.assign),JSON.stringify(old.assign));
});

test('an explicit custom tip survives a draft refresh',()=>{
  const first=app(),d=receipt(first);Object.assign(d,{tipMode:'amount',tipInput:'3.25',fees:0});
  const restored=app({view:'review',draft:d});
  assert.equal(restored.tipState(restored.S.draft).cents,325);
});

test('a restored draft combines the tip and service fee, and editing the field replaces the combined amount',()=>{
  const first=app(),d=receipt(first);
  Object.assign(d,{tipMode:'amount',tipInput:'1.23'});
  const api=app({view:'review',draft:d});
  assert.match(api.V.review(),/Tip and fees/);
  assert.doesNotMatch(api.V.review(),/data-in="fees"/);
  assert.equal(api.S.draft.tipInput,'1.43');
  assert.equal(api.calc(api.S.draft).grand,1223);
  api.dispatch('input',{target:{dataset:{in:'tipamount'},value:'0.10'}});
  assert.equal(api.calc(api.S.draft).grand,1090);
});
