const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const importer=require('../public/contact-import');
const vcard=(name,phone)=>`BEGIN:VCARD\nVERSION:3.0\nN:Test;${name};;;\nFN:${name} Test\nTEL;TYPE=CELL:${phone}\nEND:VCARD`;
test('vCard exports support structured names, Unicode, folded lines and phone URIs; other fields stay out',()=>{
  const [c]=importer.fromVCard('BEGIN:VCARD\r\nVERSION:4.0\r\nN:García;María;;;\r\nFN:María Gar\r\n cía\r\nTEL;VALUE=uri:tel:+18015550100\r\nEMAIL:private@example.test\r\nPHOTO:private\r\nEND:VCARD');
  assert.deepEqual(c,{first:'María',last:'García',name:'María García',phone:'+18015550100'});
  assert.equal(importer.fromVCard('BEGIN:VCARD\nFN:One Name\nEND:VCARD')[0].first,'One');
  assert.equal(importer.fromVCard('BEGIN:VCARD\nN:Surname;;;;\nFN:Surname\nEND:VCARD')[0].name,'Surname');
});
test('malformed, oversized and legacy encoded files fail without partial results',()=>{
  for(const text of ['not a vcard','BEGIN:VCARD\nFN:Unfinished',vcard('A','1')+'\nBEGIN:VCARD', 'BEGIN:VCARD\nN;ENCODING=QUOTED-PRINTABLE:Test;A;;;\nEND:VCARD'])assert.throws(()=>importer.fromVCard(text));
  assert.throws(()=>importer.fromVCard(' '.repeat(5*1024*1024+1)),/smaller/);
});
test('import deduplicates formatted phones, repeated entries and names without phones, preserving distinct phones',()=>{
  const entries=importer.fromVCard([vcard('Alex','+1 801 555 0100'),vcard('Sam','8015550101'),vcard('Sam','(801) 555-0101'),vcard('Sam','8015550102')].join('\n'));
  const rows=importer.prepare(entries,[{first:'Alex',last:'Test',phone:'801-555-0100'}]);
  assert.deepEqual(rows.map(r=>r.duplicate),[true,false,true,false]);
  assert.ok(rows.every(r=>!r.selected));
  assert.equal(importer.sameContact({first:' A ',last:'Lee',phone:''},{first:'a',last:'LEE',phone:''}),true);
});
function app(){
  const html=fs.readFileSync(path.join(__dirname,'../public/app.html'),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls=[],remote=[],nodes={},events={},stored={},control={fail:false,readFail:false,wait:null};let next=60;
  const client={rpc:async(name,args)=>{calls.push({name,args});if(control.wait)await control.wait;if(control.fail)return {error:{message:'Offline'}};
    const row={contact_id:args.p_contact_id || next++,cont_first_name:args.p_first_name,cont_last_name:args.p_last_name,phone:args.p_phone,contacts_payment_method:[]};
    const i=remote.findIndex(c=>c.contact_id===row.contact_id);if(i<0)remote.push(row);else remote[i]=row;return {data:row.contact_id};},
    from:()=>{let id;const q={select:()=>q,eq:(_,v)=>{id=Number(v);return q;},single:async()=>({data:remote.find(c=>c.contact_id===id),error:control.readFail?{message:'Read offline'}:null})};return q;}};
  const window={IOYA_CONFIG:{supabaseUrl:'https://example.test',supabaseAnonKey:'fixture'},IOYA_CONTACT_IMPORT:importer,supabase:{createClient:()=>client},isSecureContext:true,navigator:{}};
  window.top=window.self=window;
  const context={window,document:{getElementById:id=>nodes[id] ||= {value:'',hidden:true},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>(events[name] ||= []).push(fn)},
    localStorage:{getItem:()=>null,setItem:(k,v)=>stored[k]=v},setTimeout(){},clearTimeout(){},console};
  vm.runInNewContext(script.replace('if (!V[S.view]','render=()=>{};refreshMatch=()=>{};globalThis.api={S,ui,A,V,saveContact,stageImportedContacts,saveImportedContacts,pickDeviceContacts,readContactFile,importContactsSheet,sheetHTML};return;\nif (!V[S.view]'),context);
  const a=context.api;a.S.userId=7;a.S.loading=false;a.S.payMethods=[];a.S.contacts=[];
  return {...a,calls,remote,nodes,events,stored,control,window};
}
test('new split participant is saved to Contacts first and keeps assignments when later removed',async()=>{
  const a=app();a.S.view='assign';a.ui.contactQuery='Alex Test';a.A.newSplitContact();assert.equal(a.ui.sheet.draft.first,'Alex');
  a.nodes['f-first']={value:'Alex'};a.nodes['f-last']={value:'Test'};a.nodes['f-phone']={value:'8015550100'};
  await a.saveContact();assert.equal(a.S.contacts.length,1);assert.equal(a.S.draft.people.length,2);
  assert.equal(a.S.draft.people[1].contactId,'60');assert.equal(a.S.contacts[0].name,'Alex Test');
  a.A.rmp({id:a.S.draft.people[1].id});assert.equal(a.S.contacts.length,1);assert.equal(a.S.draft.people.length,1);
});
test('failed contact saves retain form state; readback retries reuse the saved contact id',async()=>{
  const a=app();a.A.newSplitContact();a.nodes['f-first']={value:'Alex'};a.nodes['f-last']={value:'Test'};a.nodes['f-phone']={value:'8015550100'};a.nodes['f-err']={};
  a.control.fail=true;await a.saveContact();assert.equal(a.ui.sheet.draft.first,'Alex');assert.equal(a.S.draft.people.length,1);
  a.control.fail=false;a.control.readFail=true;await a.saveContact();assert.equal(a.remote.length,1);assert.equal(a.ui.sheet.savedId,'60');
  a.control.readFail=false;await a.saveContact();assert.equal(a.remote.length,1);assert.equal(a.calls.at(-1).args.p_contact_id,60);assert.equal(a.S.contacts.length,1);
});
test('select all saves only new contacts and retries a failed read without duplicate creates',async()=>{
  const a=app();a.S.contacts=[{id:'5',first:'Alex',last:'Test',name:'Alex Test',phone:'8015550100'}];a.A.importcontacts();
  a.stageImportedContacts(a.ui.sheet,importer.fromVCard(vcard('Alex','8015550100')+'\n'+vcard('Sam','8015550101')));
  a.A.importall();a.control.readFail=true;await a.saveImportedContacts();assert.equal(a.remote.length,1);assert.equal(a.calls.length,1);
  assert.ok(a.ui.sheet.rows[1].error);a.control.readFail=false;await a.saveImportedContacts();
  assert.equal(a.calls.length,1);assert.equal(a.S.contacts.length,2);assert.equal(a.ui.sheet.rows[1].saved,true);
  assert.ok(!JSON.stringify(a.stored).includes('Sam'));
});
test('partial batch failures can retry without re-saving completed rows',async()=>{
  const a=app();a.A.importcontacts();a.stageImportedContacts(a.ui.sheet,importer.fromVCard(vcard('A','8015550101')+'\n'+vcard('B','8015550102')));a.A.importall();
  a.control.fail=true;await a.saveImportedContacts();assert.equal(a.remote.length,0);assert.match(a.ui.sheet.error,/Some contacts/);
  a.control.fail=false;await a.saveImportedContacts();assert.equal(a.remote.length,2);await a.saveImportedContacts();assert.equal(a.remote.length,2);
});
test('a cancelled picker saves nothing; selected phone contacts still require review and explicit save',async()=>{
  const a=app();a.A.importcontacts();a.window.navigator.contacts={select:async()=>{throw Object.assign(Error('cancelled'),{name:'AbortError'});}};
  await a.pickDeviceContacts();assert.equal(a.ui.sheet.error,'');assert.equal(a.calls.length,0);
  a.window.navigator.contacts.select=async()=>[{name:['Alex Test'],tel:['8015550100'],email:['private@example.test']}];
  await a.pickDeviceContacts();assert.equal(a.ui.sheet.rows.length,1);assert.equal(a.calls.length,0);assert.equal(a.ui.sheet.rows[0].selected,false);
  assert.ok(!JSON.stringify(a.ui.sheet.rows).includes('private@example'));
});
test('late responses from a different account never enter the current Contacts list',async()=>{
  const a=app();a.A.importcontacts();a.stageImportedContacts(a.ui.sheet,importer.fromVCard(vcard('A','8015550101')));a.A.importall();
  let release;a.control.wait=new Promise(r=>release=r);const pending=a.saveImportedContacts();a.S.userId=8;release();await pending;
  assert.equal(a.S.contacts.length,0);assert.equal(a.ui.saving,false);
});
test('import escapes contact content, shows fallback and closes without saving',()=>{
  const a=app();a.A.importcontacts();a.stageImportedContacts(a.ui.sheet,[{first:'<img>',last:'',name:'<img>',phone:''}]);
  assert.match(a.importContactsSheet(a.ui.sheet),/&lt;img&gt;/);assert.match(a.importContactsSheet(a.ui.sheet),/cannot open device contacts/);
  a.A.close();assert.equal(a.ui.sheet,null);assert.equal(a.calls.length,0);
});
