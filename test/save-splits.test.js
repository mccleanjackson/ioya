const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Save to History (public/app.html → save_my_split() in supabase/save-splits.sql).
const html=fs.readFileSync(path.join(__dirname,'../public/app.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const plain=x=>JSON.parse(JSON.stringify(x));
const tick=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

function app({rpc}={}){
  const calls=[], from=[], stored={};
  const client={auth:{getSession:async()=>({data:{session:{access_token:'t'}}})},
    rpc:async(name,args)=>{calls.push([name,plain(args)]);return rpc?await rpc(name,args,calls.length):{data:42,error:null};},
    from:t=>{from.push(t);throw new Error('not loaded in this test');}};
  const window={IOYA_CONFIG:{supabaseUrl:'https://supabase.example.com',supabaseAnonKey:'public-test-key'},supabase:{createClient:()=>client}};
  const el={closest:()=>el,setAttribute(){},focus(){},select(){}};
  const context={window,navigator:{userAgent:'Android',clipboard:{writeText:async()=>{}}},
    document:{getElementById:()=>el,querySelectorAll:()=>[],addEventListener(){}},
    localStorage:{getItem:k=>stored[k]??null,setItem:(k,v)=>{stored[k]=v;}},setTimeout:()=>0,clearTimeout(){},console};
  vm.runInNewContext(script.replace('if (!V[S.view]','render=()=>{};globalThis.api={S,A,V,ui,newDraft,calc,splitForSaving,preparedRequests};return;\nif (!V[S.view]'),context);
  const api=context.api;
  Object.assign(api.S,{userId:7,selfContactId:'1',paymentAccounts:{venmo:'taylor-test'},
    contacts:[{id:'2',name:'Alex Lee',first:'Alex',last:'Lee',methods:[{id:1,name:'Venmo',username:'alex-test'}],venmo:'alex-test',method:'venmo'},
              {id:'3',name:'Sam Park',first:'Sam',last:'Park',methods:[],method:'sms',phone:'8015550101'}]});
  return {...api,calls,from,stored};
}
function split(api){
  const d=api.newDraft();
  Object.assign(d,{merchant:' Sakura Ramen ',tax:300,fees:0,printed:3300,tipMode:'percent',tipPct:20,
    items:[{id:'a',name:'Ramen',price:2000},{id:'b',name:'Gyoza',price:1001},{id:'c',name:'Water',price:0}],
    people:[{id:'me',name:'You',me:true},{id:'p',name:'Alex Lee',contactId:'2',method:'venmo',venmo:'alex-test'},{id:'q',name:'Sam Park',contactId:'3',method:'sms',phone:'8015550101'}],
    assign:{a:['p'],b:['me','p','q']},at:'sent',results:[]});
  api.S.draft=d;api.S.view='sent';d.results=api.preparedRequests();return d;
}

test('the split is sent with each person\'s exact share, as contacts, and nothing is lost', ()=>{
  const api=app(), d=split(api); d.saveKey='s-key';
  const p=api.splitForSaving(d);
  assert.equal(p.client_key,'s-key');
  assert.equal(p.merchant,'Sakura Ramen');
  assert.match(p.name,/^Split on [A-Z][a-z]{2} \d{1,2}$/);
  assert.match(p.date,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.tax_cents,300);assert.equal(p.total_cents,3300);assert.equal(p.tip_percent,20);
  assert.equal(p.tip_cents,api.calc(d).tip);
  assert.deepEqual(plain(p.items),[
    {description:'Ramen',price_cents:2000,shares:[{contact_id:2,share_cents:2000}]},
    {description:'Gyoza',price_cents:1001,shares:[{contact_id:1,share_cents:334},{contact_id:2,share_cents:334},{contact_id:3,share_cents:333}]},
    {description:'Water',price_cents:0,shares:[]}]);
});

test('Save to History saves once, clears the draft, opens History and reloads it', async()=>{
  let release; const api=app({rpc:()=>new Promise(r=>release=()=>r({data:42,error:null}))}); const d=split(api);
  api.A.saveSplit(); api.A.saveSplit();  // a double tap
  assert.equal(api.ui.savingSplit,true);
  assert.match(api.V.sent(),/data-act="saveSplit" disabled>Saving…/);
  assert.equal(api.calls.length,1,'only one save while saving');
  assert.match(d.saveKey,/^s-/);
  assert.match(api.stored['ioya-draft-v1']||'',new RegExp(d.saveKey),'the key is kept in the browser before saving');
  release(); await tick();
  assert.equal(api.calls[0][0],'save_my_split');
  assert.equal(api.S.view,'history');
  assert.equal(api.S.draft.items.length,0,'draft cleared, so no Resume split');
  assert.equal(api.ui.toast,'Saved to History.');
  assert.ok(api.from.includes('users'),'History reloads from the database');
});

test('a failed save keeps the split, says why, and Try again reuses the same key', async()=>{
  const api=app({rpc:(n,a,i)=>i===1?{data:null,error:{message:'Failed to fetch'}}:{data:42,error:null}}); const d=split(api);
  api.A.saveSplit(); await tick();
  assert.equal(api.S.draft,d);assert.equal(api.S.view,'sent');
  assert.match(api.ui.saveSplitError,/Couldn't reach IOYA/);
  assert.match(api.V.sent(),/role="alert">Couldn&#39;t reach IOYA|role="alert">Couldn't reach IOYA/);
  assert.match(api.V.sent(),/data-act="saveSplit" >Try again/);
  const key=d.saveKey;
  api.A.saveSplit(); await tick();
  assert.equal(api.calls[1][1].p_split.client_key,key,'same key: the database never makes a copy');
  assert.equal(api.S.view,'history');
});

test('a database without save-splits.sql names the file; someone not in Contacts is caught first', async()=>{
  const api=app({rpc:()=>({data:null,error:{message:'Could not find the function public.save_my_split(p_split) in the schema cache'}})}); const d=split(api);
  api.A.saveSplit(); await tick();
  assert.match(api.ui.saveSplitError,/run supabase\/save-splits\.sql[\s\S]*Your split is still here/);
  const api2=app(), d2=split(api2); delete d2.people[2].contactId;
  api2.A.saveSplit(); await tick();
  assert.equal(api2.calls.length,0);
  assert.match(api2.ui.saveSplitError,/Sam Park isn't in your contacts\. Tap Edit split/);
});

test('the last screen offers Save to History, and "Not now" still keeps the split in the browser', ()=>{
  const api=app(), d=split(api);
  const out=api.V.sent();
  assert.match(out,/data-act="saveSplit" >Save to History<\/button>/);
  assert.match(out,/data-act="done"[^>]*>Not now, keep it in this browser/);
  api.A.done();
  assert.equal(api.S.draft,d);assert.equal(api.S.view,'home');
  assert.equal(api.calls.length,0);
});
