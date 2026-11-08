const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
function app({clipboardError=false,userAgent='Android'}={}){
  const copied=[], timers=[], fallback={closest:()=>fallback,focus(){this.focused=true;},select(){this.selected=true;}};
  const context={window:{},navigator:{userAgent,clipboard:{writeText:async text=>{if(clipboardError)throw Error('denied');copied.push(text);}}},
    document:{getElementById:()=>fallback,addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},
    setTimeout:fn=>timers.push(fn),clearTimeout(){},console};
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,A,V,ui,newDraft,normalizeTipDraft,requestTarget,paymentRequest,requestCard,sendPlan,sheetHTML,copyRequest,autoMessage};return;\nif (!V[S.view]'),context);
  return {...context.api,copied,timers,fallback};
}
function split(api){
  const d=api.newDraft();
  Object.assign(d,{merchant:'Test cafe',items:[{id:'a',name:'Meal',price:1000}],printed:1000,
    people:[{id:'me',name:'You',me:true},{id:'p',name:'Alex',method:'venmo',venmo:'@alex-test'}],assign:{a:['me','p']}});
  api.S.draft=d;return d;
}
const request=(overrides={})=>({name:'Alex',method:'venmo',handle:'@alex-test',amount:1234,note:'Dinner & tea? #1 + tax',...overrides});

test('Venmo opens a charge (not a payment) for one person with exact cents and encoded note',()=>{
  const api=app(), url=new URL(api.paymentRequest(request()).href);
  assert.equal(url.origin,'https://venmo.com');assert.equal(url.searchParams.get('txn'),'charge');
  assert.equal(url.searchParams.get('recipients'),'alex-test');assert.equal(url.searchParams.get('amount'),'12.34');
  assert.equal(url.searchParams.get('note'),request().note);assert.equal(url.searchParams.get('audience'),'private');
});
test('invalid handles, multiple recipients, malformed emails and unsafe amounts cannot make links',()=>{
  const api=app();
  for(const handle of ['','@one,@two','https://evil.test','abc&txn=pay','<script>']) assert.ok(api.paymentRequest(request({handle})).error);
  for(const amount of [0,-1,1.2,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) assert.ok(api.paymentRequest(request({amount})).error);
  assert.ok(api.paymentRequest(request({method:'paypal',handle:'alex'})).error);
  assert.ok(api.paymentRequest(request({method:'paypal',handle:'a@b.test\nInjected'})).error);
  assert.ok(api.paymentRequest(request({method:'unknown'})).error);
});
test('PayPal opens Request with copyable debtor details and never invents a payer payment link',()=>{
  const info=app().paymentRequest(request({method:'paypal',handle:'alex+meal@example.test'}));
  assert.equal(info.href,'https://www.paypal.com/myaccount/transfer/requestmoney');
  assert.match(info.detail,/Request from: Alex/);assert.match(info.detail,/alex\+meal@example.test/);
  assert.match(info.detail,/12.34 USD/);assert.ok(!info.href.includes('paypal.me'));
});
test('Zelle keeps email or normalizes a U.S. phone and routes through the bank',()=>{
  const api=app();
  for(const [handle,expected] of [['(801) 555-0100','+18015550100'],['+1 801-555-0100','+18015550100'],['alex@example.test','alex@example.test']]){
    const info=api.paymentRequest(request({method:'zelle',handle}));
    assert.equal(info.target,expected);assert.equal(info.href,'https://www.zellepay.com/get-started');assert.match(info.help,/bank’s app/);
  }
  assert.ok(api.requestTarget('zelle','555').error);
});
test('SMS drafts include the exact amount and custom message on Android and iPhone',()=>{
  for(const [userAgent,separator] of [['Android','?'],['iPhone','&']]){
    const info=app({userAgent}).paymentRequest(request({method:'sms',handle:'8015550100',note:'Thanks & see you!'}));
    assert.ok(info.href.startsWith('sms:+18015550100'+separator+'body='));
    const body=decodeURIComponent(info.href.split('body=')[1]);assert.match(body,/\$12.34/);assert.match(body,/Thanks & see you!/);
    assert.ok(!body.includes('ioya.app'));
  }
});
test('prepare snapshots each share and message without sending, timers or status changes',()=>{
  const api=app(),d=split(api);d.msgs.p='Custom note';api.A.send();
  assert.equal(api.S.view,'sent');assert.equal(d.results[0].amount,500);assert.equal(d.results[0].note,'Custom note');
  assert.equal(d.results[0].handle,'alex-test');assert.equal(d.results[0].handoffVersion,1);assert.equal(d.results[0].status,undefined);
  assert.equal(api.timers.length,0);assert.equal(api.copied.length,0);
  const page=api.V.sent();assert.ok(page.includes('Finish in your payment apps'));assert.ok(!page.includes('Requests sent'));
  assert.ok(!page.includes('QR code'));assert.ok(!page.includes('ioya.app'));
});
test('direct prepare is guarded by split validity and bad contacts are excluded',()=>{
  const api=app(),d=split(api);d.printed=900;api.A.send();assert.equal(d.results,null);
  d.printed=1000;d.people[1].venmo='@one,@two';assert.equal(api.sendPlan().ready.length,0);api.A.send();assert.equal(d.results,null);
});
test('editing a prepared split hides old handoffs until requests are prepared again',()=>{
  const api=app(),d=split(api);api.A.send();
  d.items[0].price=1200;d.printed=1200;
  assert.match(api.V.sent(),/Your split changed/);assert.ok(!api.V.sent().includes('href='));
  api.A.send();assert.equal(d.results[0].amount,600);assert.ok(api.V.sent().includes('Open Venmo request'));
});
test('clipboard copies exact fields and denial offers selectable manual details',async()=>{
  const api=app();split(api);api.A.send();
  await api.copyRequest({index:'0',part:'amount'});await api.copyRequest({index:'0',part:'contact'});
  assert.deepEqual(api.copied,['5.00','alex-test']);
  const denied=app({clipboardError:true});split(denied);denied.A.send();await denied.copyRequest({index:'0',part:'all'});
  assert.equal(denied.fallback.open,true);assert.equal(denied.fallback.selected,true);assert.match(denied.ui.toast,/manually/);
});
test('returning home preserves the split; legacy simulated sends are discarded on reload',()=>{
  const api=app(),d=split(api);api.A.send();api.A.done();assert.equal(api.S.draft,d);assert.equal(d.results.length,1);assert.equal(api.S.view,'home');
  const legacy={at:'sent',items:[{id:'a'}],results:[{pid:'p',status:'sent'}]};api.normalizeTipDraft(legacy);
  assert.equal(legacy.results,null);assert.equal(legacy.at,'summary');assert.equal(legacy.items.length,1);
});
test('history reminders use the current contact, preserve unpaid status, and escape editable content',()=>{
  const api=app();api.S.contacts=[{id:'42',name:'Alex',paypal:'alex@example.test'}];
  const r={contactId:42,name:'Alex',amount:1234,pref:{name:'PayPal',username:'old@example.test'},status:'requested'};
  api.S.history=[{id:'event',merchant:'Test cafe',requests:[r]}];api.ui.sheet={type:'req',sid:'event',i:0};api.A.remind();
  assert.equal(api.ui.sheet.request.handle,'alex@example.test');assert.equal(r.status,'requested');
  assert.ok(api.sheetHTML().includes('Open PayPal requests'));
  const card=api.requestCard(request({name:'<img onerror=evil>',note:'</textarea><script>evil</script>'}),0);
  assert.ok(!card.includes('<script>'));assert.ok(card.includes('&lt;script&gt;'));assert.ok(card.includes('rel="noopener noreferrer"'));
});

test('Cash App accepts a cashtag, email or phone without linking to a payment to the debtor',()=>{
  const api=app();
  for(const [handle,expected] of [['$AlexTest','$AlexTest'],['alex@example.test','alex@example.test'],['(801) 555-0100','+18015550100']]){
    const info=api.paymentRequest(request({method:'cashapp',handle}));
    assert.equal(info.target,expected);assert.equal(info.href,'https://cash.app/login');
    assert.match(info.help,/Request/);assert.match(info.help,/Apple Pay or Google Pay/);
    assert.ok(!info.href.includes(expected));
  }
  for(const handle of ['$12345','$a/b','$alex&txn=pay','https://cash.app/$AlexTest','$abcdefghijklmnopqrstu']) assert.ok(api.requestTarget('cashapp',handle).error);
});
test('Cash App rejects sub-dollar shares in preparation and explains why',()=>{
  const api=app(),d=split(api);d.people[1].method='cashapp';d.people[1].cashapp='$AlexTest';
  d.items[0].price=100;d.printed=100;
  assert.equal(api.sendPlan().ready.length,0);assert.equal(api.sendPlan().blocked.length,1);
  api.A.send();assert.equal(d.results,null);assert.match(api.paymentRequest(request({method:'cashapp',handle:'$AlexTest',amount:99})).error,/\$1/);
  d.items[0].price=200;d.printed=200;api.A.send();assert.equal(d.results[0].amount,100);
});
test('Apple Cash opens only a Messages draft and explains the native Request step',()=>{
  const api=app({userAgent:'iPhone'}), info=api.paymentRequest(request({method:'applecash',handle:'8015550100'}));
  assert.ok(info.href.startsWith('sms:+18015550100&body='));assert.match(decodeURIComponent(info.href),/\$12.34/);
  assert.match(info.help,/draft alone is not an Apple Cash request/);assert.match(info.help,/compatible Apple devices/);
  assert.ok(api.requestTarget('applecash','not-a-number').error);
  assert.ok(!api.paymentRequest(request({method:'applecash',handle:'8015550100'})).error);
});
test('cash needs no electronic contact, makes no external link and stays unpaid',()=>{
  const api=app(),d=split(api);d.people[1].method='cash';
  assert.equal(api.sendPlan().ready.length,1);api.A.send();
  assert.equal(d.results[0].amount,500);assert.equal(d.results[0].status,undefined);
  const card=api.requestCard(d.results[0],0);assert.ok(!card.includes('href='));assert.ok(!card.includes('Copy contact'));
  assert.match(card,/collect this amount in person/);
  assert.match(api.V.summary(),/No contact needed/);
});
test('all added methods appear in both new-split and reminder method choices',()=>{
  const api=app();split(api);
  api.ui.sheet={type:'payment',request:request()};
  for(const label of ['Cash App','Apple Cash','Cash']){
    assert.ok(api.V.people().includes('>'+label+'</option>'));
    assert.ok(api.V.summary().includes('>'+label+'</option>'));
    assert.ok(api.sheetHTML().includes('>'+label+'</option>'));
  }
});
