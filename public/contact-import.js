/* Contact-file parsing stays in the browser. Only reviewed, selected names/phones are saved. */
(function(root){
  'use strict';
  const text = value => String(value || '').trim();
  const phoneKey = value => {
    const digits = text(value).replace(/\D/g, '');
    return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  };
  const nameKey = value => text(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
  function sameContact(a,b){
    const ap = phoneKey(a.phone), bp = phoneKey(b.phone);
    if (ap && bp) return ap === bp;
    return !ap && !bp && nameKey(a.first + ' ' + a.last) === nameKey(b.first + ' ' + b.last);
  }
  function contact(first,last,phone){
    first = text(first); last = text(last); phone = text(phone).replace(/^tel:/i, '');
    if (!first && last){first = last; last = '';}
    if (!first) return null;
    if (first.length > 200 || last.length > 200 || phone.length > 100) throw new Error('A contact is too long. Edit the contact file and try again.');
    return {first,last,phone,name:[first,last].filter(Boolean).join(' ')};
  }
  function splitName(name){
    const parts = text(name).split(/\s+/);
    return [parts.shift() || '', parts.join(' ')];
  }
  function fromDevice(entries){
    return entries.map(entry => contact(...splitName(entry.name?.[0]), entry.tel?.[0])).filter(Boolean);
  }
  function unescape(value){return value.replace(/\\([nN,;\\])/g,(_,c)=> /n/i.test(c) ? ' ' : c);}
  function parts(value){return value.split(/(?<!\\);/).map(unescape);}
  function fromVCard(source){
    if (new TextEncoder().encode(source).length > 5 * 1024 * 1024) throw new Error('Choose a contact file smaller than 5 MB.');
    const lines = source.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').split('\n');
    const result = []; let card = null, finished = 0;
    for (const line of lines){
      if (/^BEGIN:VCARD\s*$/i.test(line)){if(card)throw new Error('This contact file is incomplete. Export it again as vCard.');card={};continue;}
      if (/^END:VCARD\s*$/i.test(line)){
        if(!card)continue;
        const n = card.n ? parts(card.n) : [], fallback = splitName(unescape(card.fn || ''));
        const named = n[0] || n[1] ? [n[1],n[0]] : fallback;
        const entry = contact(...named, unescape(card.tel || ''));
        if(entry)result.push(entry);card=null;finished++;
        if(result.length > 1000)throw new Error('Import up to 1,000 contacts at a time. Export a smaller selection.');
        continue;
      }
      if(!card)continue;
      const colon = line.indexOf(':');if(colon < 0)continue;
      const header = line.slice(0,colon), key = header.split(';')[0].split('.').pop().toUpperCase(), value = line.slice(colon+1);
      if(!['N','FN','TEL'].includes(key))continue;
      if(/ENCODING=(QUOTED-PRINTABLE|B|BASE64)/i.test(header))throw new Error('Export these contacts as UTF-8 vCard 3.0 or 4.0 and try again.');
      if(key==='N')card.n=value;
      if(key==='FN')card.fn=value;
      if(key==='TEL' && !card.tel)card.tel=value;
    }
    if(card || !finished)throw new Error('Choose a complete .vcf contact file exported from your Contacts app.');
    if(!result.length)throw new Error('No contacts with names were found in this file.');
    return result;
  }
  function prepare(entries,existing){
    const seen = [...existing], rows = [];
    for(const entry of entries){
      const duplicate = seen.some(c=>sameContact(c,entry));
      rows.push({...entry,duplicate,selected:false,saved:false,error:'',savedId:null});
      if(!duplicate)seen.push(entry);
    }
    return rows;
  }
  const api = {phoneKey,sameContact,fromDevice,fromVCard,prepare};
  if(typeof module === 'object' && module.exports)module.exports=api;
  else root.IOYA_CONTACT_IMPORT=api;
})(typeof window === 'object' ? window : globalThis);
