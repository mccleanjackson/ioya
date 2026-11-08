const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
function app(){
  const remote=[],calls=[],events={},nodes={},control={rpcError:null,readError:null,wait:null};
  let next=20;
  const contacts=[{id:'1',name:'Alex Test',first:'Alex',phone:'8015550100',method:'sms',methods:[]},{id:'2',name:'Sam Test',first:'Sam',phone:'8015550101',method:'sms',methods:[]}];
  const tables=()=>({users:[{user_id:7,user_first_name:'Test',user_last_name:'Payer',phone:''}],payment_methods:[],
    contacts:[{contact_id:50,cont_first_name:'Test',cont_last_name:'Payer',phone:'',contacts_payment_method:[]},...contacts.map(c=>({contact_id:Number(c.id),cont_first_name:c.first,cont_last_name:'Test',phone:c.phone,contacts_payment_method:[]}))],friend_groups:remote,events:[]});
  const client={auth:{getSession:async()=>({data:{session:{user:{is_anonymous:true}}}})},
    rpc:async(name,args)=>{
      calls.push({name,args});if(control.wait)await control.wait;
      if(control.rpcError)return {error:{message:control.rpcError}};
      if(name==='save_group'){
        const row={group_id:args.p_group_id || next++,group_name:args.p_name.trim(),group_members:args.p_contact_ids.map(id=>({contact_id:id}))};
        const i=remote.findIndex(g=>g.group_id===row.group_id);if(i<0)remote.push(row);else remote[i]=row;
        return {data:row.group_id,error:null};
      }
      if(name==='delete_group'){const i=remote.findIndex(g=>g.group_id===args.p_group_id);if(i>=0)remote.splice(i,1);return {data:null,error:null};}
    },
    from:name=>{
      let id=null;const q={select:()=>q,order:()=>q,eq:(key,value)=>{if(key==='group_id')id=Number(value);return q;},
        single:async()=>({data:(tables()[name] || []).find(g=>id===null || g.group_id===id),error:control.readError?{message:control.readError}:null}),
        then:(resolve,reject)=>Promise.resolve({data:tables()[name],error:null}).then(resolve,reject)};return q;
    }};
  const context={window:{IOYA_CONFIG:{supabaseUrl:'https://example.test',supabaseAnonKey:'fixture'},supabase:{createClient:()=>client}},
    document:{getElementById:id=>nodes[id] || (nodes[id]={focus(){},hidden:true}),addEventListener:(name,fn)=>(events[name] ||= []).push(fn)},
    localStorage:{getItem:()=>null,setItem(){}},setTimeout(){},clearTimeout(){},console};
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,ui,A,V,loadAll,saveGroup,deleteGroup,groupMembers,groupSheet,sheetHTML};return;\nif (!V[S.view]'),context);
  const api=context.api;api.S.userId=7;api.S.selfContactId='50';api.S.contacts=contacts;api.S.loading=false;
  return {...api,remote,calls,control,nodes,events};
}
const draft=(api,name,members=[])=>{api.A.sheet({s:'group'});Object.assign(api.ui.sheet.draft,{name,members});return api.ui.sheet;};

test('Contacts exposes New group and an empty state; member selection excludes You',()=>{
  const a=app();assert.match(a.V.contacts(),/New group/);assert.match(a.V.contacts(),/No groups yet/);
  const s=draft(a,'Crew');a.S.contacts.push({id:'50',name:'You'});
  assert.ok(!a.groupMembers(s).includes('value="50"'));assert.match(a.groupSheet(s),/Save group/);
});
test('create uses the existing RPC, reads back its row, and survives a fresh load',async()=>{
  const a=app();draft(a,'  Lunch crew  ',['1','2']);await a.saveGroup();
  assert.equal(a.calls[0].name,'save_group');assert.equal(a.calls[0].args.p_group_id,null);
  assert.equal(a.calls[0].args.p_name,'Lunch crew');assert.deepEqual(Array.from(a.calls[0].args.p_contact_ids),[1,2]);
  assert.equal(a.ui.sheet,null);assert.equal(a.S.groups[0].name,'Lunch crew');
  a.S.groups=[];await a.loadAll();assert.equal(a.S.groups[0].name,'Lunch crew');assert.deepEqual(Array.from(a.S.groups[0].members),['1','2']);
});
test('edit replaces all members, and empty groups can be saved and reloaded',async()=>{
  const a=app();draft(a,'Crew',['1','2']);await a.saveGroup();
  a.A.sheet({s:'group',id:'20'});a.ui.sheet.draft.name='Renamed';a.ui.sheet.draft.members=['2'];await a.saveGroup();
  assert.equal(a.remote.length,1);assert.deepEqual(Array.from(a.S.groups[0].members),['2']);
  a.A.sheet({s:'group',id:'20'});a.ui.sheet.draft.members=[];await a.saveGroup();await a.loadAll();
  assert.equal(a.S.groups[0].name,'Renamed');assert.equal(a.S.groups[0].members.length,0);
});
test('blank names and stale/self contact IDs show errors without sending anything',async()=>{
  const a=app();let s=draft(a,'  ',['1']);await a.saveGroup();assert.equal(a.calls.length,0);assert.equal(s.error,'Add a group name.');
  for(const id of ['50','999','1.5']){s=draft(a,'Crew',[id]);await a.saveGroup();assert.match(s.error,/no longer exists/);}
  assert.equal(a.calls.length,0);
});
test('save errors preserve the typed name and selected members for retry',async()=>{
  const a=app(),s=draft(a,'  Keep this name ',['2']);a.control.rpcError='Network offline';await a.saveGroup();
  assert.equal(a.ui.sheet,s);assert.equal(s.draft.name,'  Keep this name ');assert.deepEqual(Array.from(s.draft.members),['2']);
  assert.match(s.error,/Network offline/);assert.equal(a.ui.saving,false);assert.equal(a.S.groups.length,0);
  a.control.rpcError=null;await a.saveGroup();assert.equal(a.S.groups[0].name,'Keep this name');
});
test('a successful create followed by readback failure retries the saved ID without duplicates',async()=>{
  const a=app(),s=draft(a,'Crew',['1']);a.control.readError='Read offline';await a.saveGroup();
  assert.equal(s.id,'20');assert.match(s.error,/was saved/);assert.equal(a.remote.length,1);
  a.control.readError=null;await a.saveGroup();assert.equal(a.calls[1].args.p_group_id,20);assert.equal(a.remote.length,1);
});
test('delete requires confirmation, can be cancelled, and keeps contacts, history and split data',async()=>{
  const a=app();draft(a,'Crew',['1']);await a.saveGroup();
  a.A.sheet({s:'group',id:'20'});await a.deleteGroup();assert.equal(a.remote.length,1);
  a.A.askdeletegroup();assert.match(a.groupSheet(a.ui.sheet),/contacts and past splits stay/);a.A.keepgroup();assert.equal(a.ui.sheet.confirmDelete,false);
  const contacts=a.S.contacts,history=a.S.history,split=a.S.draft;
  a.A.askdeletegroup();await a.deleteGroup();assert.equal(a.remote.length,0);assert.equal(a.S.groups.length,0);
  assert.equal(a.S.contacts,contacts);assert.equal(a.S.history,history);assert.equal(a.S.draft,split);
  await a.loadAll();assert.equal(a.S.groups.length,0);
});
test('delete errors keep the confirmation and group so it can be retried',async()=>{
  const a=app();draft(a,'Crew',['1']);await a.saveGroup();a.A.sheet({s:'group',id:'20'});a.A.askdeletegroup();
  const s=a.ui.sheet;a.control.rpcError='Delete failed';await a.deleteGroup();
  assert.equal(a.ui.sheet,s);assert.equal(s.confirmDelete,true);assert.match(s.error,/Delete failed/);assert.equal(a.S.groups.length,1);
});
test('saving blocks double submits and closing, and ignores a response for a different account',async()=>{
  const a=app();draft(a,'Crew',['1']);let release;a.control.wait=new Promise(r=>release=r);
  const pending=a.saveGroup();assert.equal(a.ui.saving,true);await a.saveGroup();a.A.close();assert.equal(a.ui.sheet.type,'group');
  assert.equal(a.calls.length,1);a.S.userId=8;release();await pending;assert.equal(a.S.groups.length,0);assert.equal(a.ui.saving,false);
});
test('editing/searching members keeps selections and escapes user-provided text',()=>{
  const a=app(),s=draft(a,'<script>bad</script>',['1']);s.query='sam';
  assert.ok(!a.groupMembers(s).includes('Alex Test'));assert.match(a.groupMembers(s),/Sam Test/);assert.deepEqual(s.draft.members,['1']);
  s.query='nobody';assert.match(a.groupMembers(s),/No contacts match/);assert.ok(!a.groupSheet(s).includes('<script>'));
});
test('a saved group still adds its members to the split without duplicate people',async()=>{
  const a=app();draft(a,'Crew',['1','2']);await a.saveGroup();a.A.addg({id:'20'});a.A.addg({id:'20'});
  assert.equal(a.S.draft.people.filter(p=>p.contactId==='1').length,1);assert.equal(a.S.draft.people.filter(p=>p.contactId==='2').length,1);
});
