const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/app.html'),'utf8');
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
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,A,V,LIVE,ui,newDraft,normalizeTipDraft,requestTarget,paymentRequest,requestCard,sendPlan,sheetHTML,copyRequest,normContact,preparedRequests};return;\nif (!V[S.view]'),context);
  if (preview) context.api.S.me={first:'Taylor',last:'Preview',phone:''};
  context.api.S.paymentAccounts={venmo:'taylor-preview',paypal:'TaylorPreview',zelle:'payer@example.test',cashapp:'$Taylor',applecash:'8015550104'};
  return {...context.api,copied,timers,fallback};
}
function split(api){
  const d=api.newDraft();
  Object.assign(d,{merchant:'Test cafe',items:[{id:'a',name:'Meal',price:1000}],printed:1000,
    people:[{id:'me',name:'You',me:true},{id:'p',name:'Alex',method:'venmo',venmo:'@alex-test',contactId:'11'}],assign:{a:['me','p']}});
  api.S.draft=d;return d;
}
const request=(overrides={})=>({name:'Alex',method:'venmo',handle:'@alex-test',amount:1234,note:'Dinner & tea? #1 + tax',...overrides});

function outstandingHistory(api){
  const bill = (id, merchant, requests) => ({id, merchant, eventName:merchant, requests, date:'2026-11-09', you:1000, receipts:[]});
  const share = (contactId, name, amount, status='requested') => ({contactId, name, amount, status});
  api.S.contacts = [{id:'1',name:'Alex',first:'Alex',phone:'(801) 555-0102'},{id:'3',name:'Jordan',phone:''}];
  api.S.history = [
    bill('1','Café & Tea',[share(1,'Alex',1225),share(2,'Sam',600,'paid'),share(4,'Morgan',0)]),
    bill('2','Lunch counter',[share('1','Alex',500),share(3,'Jordan',250)]),
    bill('3','Pizza place',[share(1,'Alex',200,'paid')]),
    bill('4','Solo snack',[share(4,'Morgan',0)])
  ];
}

test('History separates paid, partly paid and unpaid bills and Home expands only outstanding shares',()=>{
  const api=app();
  outstandingHistory(api);
  const all=api.V.history();
  assert.deepEqual([...all.matchAll(/data-k="h" data-f="([^"]+)"/g)].map(m=>m[1]),['all','unpaid','part','paid']);
  assert.match(all,/2 paid, 1 partly paid, 1 unpaid/);
  api.ui.hf='unpaid';
  const unpaid=api.V.history();
  assert.match(unpaid,/Lunch counter/);
  assert.doesNotMatch(unpaid,/Café &amp; Tea|Pizza place|Solo snack/);
  api.ui.hf='part';
  const part=api.V.history();
  assert.match(part,/Café &amp; Tea/);
  assert.match(part,/Partly paid/);
  assert.doesNotMatch(part,/Lunch counter|Pizza place|Solo snack/);
  api.ui.hq='Jordan';
  assert.doesNotMatch(api.V.history(),/Café &amp; Tea/);
  api.ui.hq='';
  api.ui.hf='paid';
  assert.match(api.V.history(),/Pizza place/);
  assert.doesNotMatch(api.V.history(),/Café &amp; Tea|Lunch counter/);
  assert.doesNotMatch(api.V.home(),/Alex|Sam|Pizza place|Solo snack/);
  api.ui.homeOpen='1';
  assert.match(api.V.home(),/data-sid="1" data-i="0"><b>Alex/);
  assert.match(api.V.home(),/\$19\.75/);
  assert.doesNotMatch(api.V.home(),/Sam|Morgan|Jordan/);
  api.S.history[0].requests[0].status='paid';
  assert.doesNotMatch(api.V.home(),/Café &amp; Tea|Alex/);
});

test('Home prepares separate texts by contact, with exact balances and a copy fallback for a missing phone',async()=>{
  for (const [userAgent, separator] of [['Android','?'],['iPhone','&']]){
    const api=app({userAgent});
    outstandingHistory(api);
    api.A.sheet({s:'reminders'});
    const sheet=api.sheetHTML();
    const links=[...sheet.matchAll(/href="(sms:[^"]+)"/g)];
    assert.equal(links.length,1);
    const href=links[0][1].replaceAll('&amp;','&');
    assert.ok(href.startsWith('sms:+18015550102'+separator+'body='));
    const message=decodeURIComponent(href.split('body=')[1]);
    assert.match(message,/Hi Alex!.*\$17\.25/);
    assert.match(message,/Café & Tea.*\$12\.25/);
    assert.match(message,/Lunch counter.*\$5\.00/);
    assert.doesNotMatch(message,/Pizza place|Jordan|Sam|\$6\.00/);
    assert.match(sheet,/Message for Jordan/);
    assert.match(sheet,/No phone number saved/);
    api.fallback.value=message;
    await api.A.copyReminder({index:'0'});
    assert.deepEqual(api.copied,[message]);
    assert.equal(api.S.history[0].requests[0].status,'requested');
  }
});

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
test('QR preparation requires assigned items and a saved contact for every share',async()=>{
  const api=app({preview:true,fetch:()=>assert.fail('An invalid split must not create links')}),d=split(api);
  d.assign.a=[];
  await api.A.send();
  assert.equal(d.results,null);
  d.assign.a=['me','p'];delete d.people[1].contactId;
  assert.equal(api.sendPlan().blocked.length,1);
  await api.A.send();
  assert.equal(d.results,null);
});
test('clipboard copies exact fields and denial offers selectable manual details',async()=>{
  const api=app();api.ui.sheet={type:'payment',request:request()};
  await api.copyRequest({index:'sheet',part:'amount'});await api.copyRequest({index:'sheet',part:'contact'});
  assert.deepEqual(api.copied,['12.34','alex-test']);
  const denied=app({clipboardError:true});denied.ui.sheet={type:'payment',request:request()};
  await denied.copyRequest({index:'sheet',part:'all'});
  assert.equal(denied.fallback.open,true);assert.equal(denied.fallback.selected,true);assert.match(denied.ui.toast,/manually/);
});
test('returning home preserves the split; legacy simulated sends are discarded on reload',()=>{
  const api=app(),d=split(api);d.results=api.preparedRequests();
  api.A.done();assert.equal(api.S.draft,d);assert.equal(d.results.length,1);assert.equal(api.S.view,'home');
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
test('Cash App reminders reject sub-dollar shares and explain why',()=>{
  const api=app(), cashApp={method:'cashapp',handle:'$AlexTest'};
  assert.match(api.paymentRequest(request({...cashApp,amount:99})).error,/\$1/);
  assert.ok(api.paymentRequest(request({...cashApp,amount:100})).href);
});
test('Apple Cash opens only a Messages draft and explains the native Request step',()=>{
  const api=app({userAgent:'iPhone'}), info=api.paymentRequest(request({method:'applecash',handle:'8015550100'}));
  assert.ok(info.href.startsWith('sms:+18015550100&body='));assert.match(decodeURIComponent(info.href),/\$12.34/);
  assert.match(info.help,/draft alone is not an Apple Cash request/);assert.match(info.help,/compatible Apple devices/);
  assert.ok(api.requestTarget('applecash','not-a-number').error);
  assert.ok(!api.paymentRequest(request({method:'applecash',handle:'8015550100'})).error);
});
test('cash needs no electronic contact, makes no external link and stays unpaid',()=>{
  const api=app();
  const card=api.requestCard(request({method:'cash',handle:''}),'sheet');assert.ok(!card.includes('href='));assert.ok(!card.includes('Copy contact'));
  assert.match(card,/collect this amount in person/);
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

test('one preview QR includes Venmo contacts and contacts with or without a phone',async()=>{
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
  const review=api.V.summary();
  assert.doesNotMatch(review,/alex-test|8015550100|data-in="pmsg"|<select/);
  await api.A.send();
  assert.ok(d.results.every(r=>r.method==='manual' && r.status===undefined));
  assert.equal(calls[0].body.contactId,11);
  assert.deepEqual(calls[0].body.items,[{name:'Meal',amountCents:200}]);
  assert.equal(calls[0].body.note,undefined);
  assert.deepEqual(calls.at(-1).body.recipients,[{id:'1',name:'Alex'},{id:'2',name:'Sam'},{id:'3',name:'Jordan'},{id:'4',name:'Morgan'}]);
  const page=api.V.sent();
  assert.equal((page.match(/alt="Shared QR code/g)||[]).length,1);
  assert.match(page,/No requests were sent/);
  assert.doesNotMatch(page,/Back to review/);
  assert.match(page,/Edit split/);
  const oldQr=d.sharedQr.id;
  d.items[0].name='Updated item';
  assert.match(api.V.sent(),/Your split changed/);
  assert.doesNotMatch(api.V.sent(),/href=/);
  api.A.go({v:'summary'});
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

test('production creates and reuses a QR even when the only recipient has Venmo',async()=>{
  const calls=[];
  const api=app({production:true,fetch:async (url,request)=>{
    calls.push({url,body:JSON.parse(request.body)});
    const id=url.endsWith('/group')?'group-id':'manual-link';
    return {ok:true,json:async()=>({id,url:'https://ioya.example.com/pay#'+id})};
  }}), d=split(api);
  api.S.me.first='Taylor';
  api.S.userId=1;
  api.S.paymentAccounts={venmo:'taylor-preview'};
  assert.match(api.V.summary(),/Apple Pay checkout for Alex/);
  await api.A.send();
  assert.deepEqual(calls.map(call=>call.url),['/api/manual-requests','/api/manual-requests/group']);
  assert.deepEqual(calls[0].body.methods,{venmo:'taylor-preview'});
  assert.deepEqual(calls[1].body,{recipients:[{id:'manual-link',name:'Alex'}]});
  assert.match(api.V.sent(),/Open shared payment page/);
  assert.doesNotMatch(api.V.sent(),/Open Venmo request|I sent the request|sms:/);
  api.A.go({v:'summary'});
  await api.A.send();
  assert.equal(calls.length,2);
  assert.match(api.V.sent(),/Open shared payment page/);
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

test('history reminders use the saved Apple Cash address',()=>{
  const api=app(),d=split(api);
  const c=api.normContact({contact_id:12,cont_first_name:'Alex',cont_last_name:'',phone:'8015550100',
    contacts_payment_method:[{pay_method_id:6,pay_method_username:'+18015550199',is_preferred:true,payment_methods:{pay_method_name:'Apple Cash'}}]});
  Object.assign(d.people[1],c,{id:'p',contactId:c.id});
  api.S.contacts=[c];
  const bill={id:'event',merchant:'Test cafe',requests:[{contactId:12,name:'Alex',amount:500}]};
  api.S.history=[bill];
  api.ui.sheet={type:'req',sid:bill.id,i:0};
  api.A.remind();
  const linked=api.ui.sheet.request;
  assert.equal(linked.method,'applecash');
  assert.equal(linked.handle,'+18015550199');
  assert.match(api.paymentRequest(linked).href,/^sms:\+18015550199/);
});

test('Cash App shares below one dollar fall back to the manual payment link',()=>{
  const api=app(),d=split(api);
  d.items[0].price=150;
  d.printed=150;
  Object.assign(d.people[1],{contactId:'12',method:'cashapp',cashapp:'$AlexTest'});
  const [request]=api.preparedRequests();
  assert.equal(request.method,'manual');
  assert.equal(request.amount,75);
});

test('production groups all positive shares without sending app requests or texts',async()=>{
  const calls=[];
  const api=app({production:true,fetch:async (url,request)=>{
    const body=JSON.parse(request.body);
    calls.push({url,body});
    const linkId=body.contactId?'link-'+body.contactId:'group-id';
    return {ok:true,json:async()=>({id:linkId,url:'https://ioya.example.com/pay#'+linkId})};
  }}),d=split(api);
  api.S.me.first='Taylor';api.S.userId=1;
  api.S.paymentAccounts={venmo:'taylor-preview'};
  d.people.push({id:'sms',name:'Sam',method:'paypal',paypal:'sam@example.test',venmo:'sam-venmo',contactId:'12',phone:'8015550100'},
    {id:'qr',name:'Jordan',method:'paypal',paypal:'jordan@example.test',contactId:'13',phone:''},
    {id:'zero',name:'Drew',method:'cash',contactId:'14'});
  d.assign.a.push('sms','qr');
  const actions=api.LIVE.sendbar();
  assert.deepEqual([...actions.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]),['Create payment QR code']);
  await api.A.send();
  assert.equal(api.S.view,'sent');
  assert.deepEqual(calls.map(x=>x.url),['/api/manual-requests','/api/manual-requests','/api/manual-requests','/api/manual-requests/group']);
  assert.deepEqual(calls[3].body.recipients,[{id:'link-11',name:'Alex'},{id:'link-12',name:'Sam'},{id:'link-13',name:'Jordan'}]);
  assert.ok(calls.slice(0,3).every(({body})=>body.phone===undefined && body.handle===undefined));
  const page=api.V.sent();
  assert.match(page,/Shared QR code/);
  assert.match(page,/Open shared payment page/);
  assert.doesNotMatch(page,/Open Venmo request|I sent the request|sms:/);
});

test('QR requests include only the recipient’s items and exact shares',()=>{
  const api=app(), d=split(api);
  d.items.push({id:'b',name:'Taco',price:200,quantity:2},{id:'c',name:'Coffee',price:300});
  Object.assign(d.assign,{b:['p'],c:['me']});
  const [r]=api.preparedRequests();
  assert.deepEqual(Array.from(r.items, item=>[item.name,item.amountCents]),[['Meal',500],['Taco',400]]);
  assert.equal(r.amount,900);
});

test('payment preparation explains an HTML response from an outdated preview server', async()=>{
  const api=app({preview:true,fetch:async()=>new Response('<!DOCTYPE html>',{status:404})});
  const d=split(api);
  d.people[1].contactId='12';
  d.people[1].method='manual';
  d.people[1].venmo='';
  api.S.view='summary';
  await api.A.send();
  assert.equal(api.S.view,'summary');
  assert.match(api.ui.sendError,/Restart the IOYA preview server/);
  assert.equal(api.ui.preparing,false);
});
