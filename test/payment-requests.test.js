const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
function app({clipboardError=false,userAgent='Android',preview=false,production=false,fetch}={}){
  const copied=[], timers=[], fallback={closest:()=>fallback,setAttribute(){},focus(){this.focused=true;},select(){this.selected=true;}};
  const window=preview?{IOYA_CONFIG:{preview:true}}:production?{
    IOYA_CONFIG:{supabaseUrl:'https://supabase.example.com',supabaseAnonKey:'public-test-key'},
    supabase:{createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-session'}}})}})}
  }:{};
  const context={window,fetch,navigator:{userAgent,clipboard:{writeText:async text=>{if(clipboardError)throw Error('denied');copied.push(text);}}},
    document:{getElementById:()=>fallback,querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},
    setTimeout:fn=>timers.push(fn),clearTimeout(){},console};
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,A,V,ui,newDraft,normalizeTipDraft,requestTarget,paymentRequest,requestCard,sendPlan,sheetHTML,copyRequest,autoMessage,normContact,preparedRequests};return;\nif (!V[S.view]'),context);
  if (preview) context.api.S.me={first:'Taylor',last:'Preview',phone:''};
  context.api.S.paymentAccounts={venmo:'taylor-preview',paypal:'TaylorPreview',zelle:'payer@example.test',cashapp:'$Taylor',applecash:'8015550104'};
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
test('SMS drafts omit custom notes on Android and iPhone',()=>{
  for(const [userAgent,separator] of [['Android','?'],['iPhone','&']]){
    const info=app({userAgent}).paymentRequest(request({method:'sms',handle:'8015550100',note:'Thanks & see you!'}));
    assert.ok(info.href.startsWith('sms:+18015550100'+separator+'body='));
    const body=decodeURIComponent(info.href.split('body=')[1]);assert.match(body,/\$12.34/);assert.doesNotMatch(body,/Thanks & see you!/);
    assert.ok(!body.includes('ioya.app'));
  }
});
test('prepare snapshots each share and message without sending, timers or status changes',()=>{
  const api=app(),d=split(api);d.msgs.p='Custom note';api.A.send();
  assert.equal(api.S.view,'sent');assert.equal(d.results[0].amount,500);assert.equal(d.results[0].note,'Custom note');
  assert.equal(d.results[0].handle,'alex-test');assert.equal(d.results[0].handoffVersion,1);assert.equal(d.results[0].status,undefined);
  assert.equal(api.timers.length,0);assert.equal(api.copied.length,0);
  const page=api.V.sent();assert.ok(page.includes('Payment requests'));assert.ok(!page.includes('Requests sent'));
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
  const api=app();api.S.contacts=[{id:'42',name:'Alex',method:'paypal',paypal:'alex@example.test'}];
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
  assert.match(api.V.summary(),/In person/);
});
test('reminder method choices remain available alongside the simpler split review',()=>{
  const api=app();split(api);
  api.ui.sheet={type:'payment',request:request()};
  for(const label of ['Cash App','Apple Cash','Cash']){
    assert.ok(api.sheetHTML().includes('>'+label+'</option>'));
  }
});

test('contacts and overlapping groups add each person once and remove their assignments',()=>{
  const api=app(), d=split(api);
  d.people=d.people.slice(0,1); d.assign={};
  api.S.contacts=[{id:'11',name:'Alex',method:'venmo',venmo:'alex-test'},{id:'12',name:'Sam',method:'sms',phone:'8015550100'}];
  api.S.groups=[{id:'g',name:'Lunch crew',members:['11','12']}];
  api.fallback.querySelectorAll=()=>[];
  api.A.addc({id:'11'}); api.A.addg({id:'g'}); api.A.addg({id:'g'});
  assert.deepEqual(Array.from(d.people,p=>p.name),['You','Alex','Sam']);
  assert.match(api.V.assign(),/0 of 1 matched/);
  api.A.matchPerson({id:d.people[2].id});
  api.A.toggle({id:'a'});
  assert.match(api.V.assign(),/1 of 1 matched/);
  api.A.rmp({id:d.people[2].id});
  assert.match(api.V.assign(),/0 of 1 matched/);
});

test('review uses saved accounts, prefills phone and sends blank phones to one shared QR',async()=>{
  const calls=[];
  const api=app({preview:true,fetch:async (url,request)=>{
    if (!request.body) return {ok:true,json:async()=>({})};
    const body=JSON.parse(request.body); calls.push({url,body});
    const id=String(calls.length);
    return {ok:true,json:async()=>({id,url:'http://127.0.0.1:3003/pay.html#'+id})};
  }}),d=split(api);
  d.people.push({id:'sms',name:'Sam',method:'sms',contactId:'12',phone:'8015550100'},
    {id:'qr',name:'Jordan',method:'sms',contactId:'13',phone:''},
    {id:'qr2',name:'Morgan',method:'sms',contactId:'14',phone:''});
  d.assign.a.push('sms','qr','qr2');
  d.msgs.p='Thanks for lunch';
  d.msgs.sms='Old text note';
  const review=api.V.summary();
  assert.match(review,/alex-test/);
  assert.match(review,/value="8015550100"/);
  assert.match(review,/value="" placeholder="\(555\)/);
  assert.match(review,/Thanks for lunch/);
  assert.doesNotMatch(review,/Old text note/);
  assert.equal((review.match(/data-in="pmsg"/g)||[]).length,1);
  assert.doesNotMatch(review,/<select/);
  await api.A.send();
  assert.equal(d.results[1].phone,'+18015550100');
  assert.equal(d.results[2].phone,'');
  assert.deepEqual(calls[0].body.items,[{name:'Meal',amountCents:200}]);
  assert.equal(calls[0].body.note,undefined);
  assert.deepEqual(calls.at(-1).body.recipients,[{id:'2',name:'Jordan'},{id:'3',name:'Morgan'}]);
  const page=api.V.sent();
  assert.equal((page.match(/alt="Shared QR code/g)||[]).length,1);
  assert.match(page,/No requests were sent/);
  assert.doesNotMatch(page,/Back to review/);
  assert.match(page,/Edit split/);
  const oldQr=d.sharedQr.id;
  api.A.go({v:'summary'});
  d.items[0].name='Updated item';
  await api.A.send();
  assert.notEqual(d.sharedQr.id,oldQr);
  assert.ok(calls.some(x=>x.body.contactId===13 && x.body.items[0].name==='Updated item'));
});

test('matching keeps the selected contact and lists unmatched items before continuing',()=>{
  const api=app(), d=split(api);
  d.items.push({id:'b',name:'Side salad',price:300});
  d.printed=1300;
  api.S.view='assign';
  api.A.matchNext();
  assert.equal(api.S.view,'assign');
  assert.match(api.sheetHTML(),/Side salad/);
  api.A.fixMatches();
  api.A.matchPerson({id:'p'});
  api.A.toggle({id:'b'});
  assert.deepEqual(Array.from(d.assign.b),['p']);
  api.A.matchNext();
  assert.equal(api.S.view,'summary');
});

test('production submits phone requests server-side and shows only confirmed app requests as requested',async()=>{
  const calls=[];
  const api=app({production:true,fetch:async (url,request)=>{
    calls.push({url,body:JSON.parse(request.body)});
    return {ok:true,json:async()=>url.endsWith('/sms')?{status:'submitted'}:{id:'sms-link',url:'https://ioya.example.com/pay#sms-link'}};
  }}), d=split(api);
  api.S.me.first='Taylor';
  api.S.userId=1;
  api.S.paymentAccounts={venmo:'taylor-preview'};
  d.people.push({id:'sms',name:'Sam',method:'sms',contactId:'12',phone:'8015550100'});
  d.assign.a.push('sms');
  await api.A.send();
  assert.deepEqual(calls.map(call=>call.url),['/api/manual-requests','/api/manual-requests/sms-link/sms']);
  assert.deepEqual(calls[1].body,{phone:'+18015550100'});
  assert.match(api.V.sent(),/Text submitted/);
  assert.doesNotMatch(api.V.sent(),/Requested using Venmo|sms:/);
  api.A.confirmLinked({index:'0'});
  assert.match(api.V.sent(),/Requested using Venmo/);
  assert.doesNotMatch(api.V.sent(),/Copy contact/);
  api.A.go({v:'summary'});
  await api.A.send();
  assert.equal(calls.length,2);
  assert.match(api.V.sent(),/Requested using Venmo/);
});

test('the active tab preserves the current split step and active page state',()=>{
  const api=app(),draft=split(api);
  for(const view of ['scan','scanning','review','assign','summary','sent']){
    api.S.view=view;
    api.A.tab({v:'split'});
    assert.equal(api.S.view,view);
    assert.equal(api.S.draft,draft);
  }
  api.S.view='contacts';
  api.ui.sheet={type:'contact'};
  api.A.tab({v:'contacts'});
  assert.equal(api.ui.sheet.type,'contact');
  api.A.tab({v:'history'});
  assert.equal(api.S.view,'history');
  assert.equal(api.ui.sheet,null);
});

test('Review and Send chooses only methods shared with the payer and falls back to phone or QR',()=>{
  const api=app(),d=split(api);
  Object.assign(d.people[1],{contactId:'20',method:'paypal',paypal:'alex@example.test',phone:'8015550100'});
  api.S.contacts=[{id:'20',method:'paypal',paypal:'alex@example.test',venmo:'current-alex',phone:'8015550100'}];
  api.S.paymentAccounts={paypal:'TaylorPreview',venmo:'taylor-preview'};
  assert.match(api.V.summary(),/alex@example.test/);
  api.S.paymentAccounts={venmo:'taylor-preview'};
  const preferredUnavailable=api.V.summary();
  assert.match(preferredUnavailable,/value="8015550100"/);
  assert.doesNotMatch(preferredUnavailable,/current-alex|alex@example.test/);
  api.S.contacts[0].method='sms';
  assert.match(api.V.summary(),/current-alex/);
  api.S.paymentAccounts={applecash:'8015550104'};
  const fallback=api.V.summary();
  assert.match(fallback,/value="8015550100"/);
  assert.doesNotMatch(fallback,/current-alex|data-in="pmsg"/);
  d.people[1].phone='';
  assert.match(api.V.summary(),/value="" placeholder="\(555\)/);
});

test('saved Apple Cash addresses reach Messages without replacing the SMS fallback phone',()=>{
  const api=app(),d=split(api);
  const c=api.normContact({contact_id:12,cont_first_name:'Alex',cont_last_name:'',phone:'8015550100',
    contacts_payment_method:[{pay_method_id:6,pay_method_username:'+18015550199',is_preferred:true,payment_methods:{pay_method_name:'Apple Cash'}}]});
  Object.assign(d.people[1],c,{id:'p',contactId:c.id});
  api.S.contacts=[c];
  const [linked]=api.preparedRequests();
  assert.equal(linked.method,'applecash');
  assert.equal(linked.handle,'+18015550199');
  assert.match(api.paymentRequest(linked).href,/^sms:\+18015550199/);
  api.S.paymentAccounts={};
  const [manual]=api.preparedRequests();
  assert.equal(manual.method,'manual');
  assert.equal(manual.phone,'+18015550100');
});

test('Cash App shares below one dollar fall back to the manual payment link',()=>{
  const api=app(),d=split(api);
  d.items[0].price=150;
  d.printed=150;
  Object.assign(d.people[1],{contactId:'12',method:'cashapp',cashapp:'$AlexTest'});
  const [request]=api.preparedRequests();
  assert.equal(request.method,'manual');
  assert.equal(request.phone,'');
  assert.equal(request.amount,75);
});

test('one production send prepares the preferred app, submits only eligible SMS, and opens a shared QR',async()=>{
  const calls=[];
  const api=app({production:true,fetch:async (url,request)=>{
    const body=JSON.parse(request.body);
    calls.push({url,body});
    const linkId=body.contactId?'link-'+body.contactId:'group-id';
    if (url.endsWith('/sms')) return {ok:false,status:503,json:async()=>({error:'Automatic texts are unavailable.'})};
    return {ok:true,json:async()=>({id:linkId,url:'https://ioya.example.com/pay#'+linkId})};
  }}),d=split(api);
  api.S.me.first='Taylor';api.S.userId=1;
  api.S.paymentAccounts={venmo:'taylor-preview'};
  d.people.push({id:'sms',name:'Sam',method:'paypal',paypal:'sam@example.test',venmo:'sam-venmo',contactId:'12',phone:'8015550100'},
    {id:'qr',name:'Jordan',method:'paypal',paypal:'jordan@example.test',contactId:'13',phone:''});
  d.assign.a.push('sms','qr');
  await api.A.send();
  assert.equal(api.S.view,'sent');
  assert.deepEqual(calls.map(x=>x.url),['/api/manual-requests','/api/manual-requests','/api/manual-requests/group','/api/manual-requests/link-12/sms']);
  assert.deepEqual(calls[2].body.recipients,[{id:'link-13',name:'Jordan'}]);
  assert.deepEqual(calls[3].body,{phone:'+18015550100'});
  const page=api.V.sent();
  assert.match(page,/Open Venmo request/);
  assert.match(page,/Shared QR code/);
  assert.match(page,/Text not submitted/);
  assert.match(page,/Open payment link/);
  assert.doesNotMatch(page,/Requested using Venmo|Text submitted/);
});
