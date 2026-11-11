const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../public/session.js'), 'utf8');

// A tiny cookie jar that behaves like document.cookie: reading lists name=value pairs, writing one
// cookie at a time with attributes, and Max-Age=0 deletes it.
function browser({protocol = 'https:', stored = {}} = {}){
  const jar = new Map(), writes = [], local = new Map(Object.entries(stored));
  const document = {
    get cookie(){ return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line){
      writes.push(line);
      const [pair, ...attrs] = line.split(';').map(s => s.trim());
      const i = pair.indexOf('='), name = pair.slice(0, i), value = pair.slice(i + 1);
      if (attrs.some(a => /^max-age=0$/i.test(a))) jar.delete(name); else jar.set(name, value);
    }
  };
  const localStorage = {getItem:k => local.has(k) ? local.get(k) : null, setItem:(k, v) => local.set(k, String(v)), removeItem:k => local.delete(k)};
  const window = {};
  vm.runInNewContext(code, {window, document, localStorage, location:{protocol}, encodeURIComponent, decodeURIComponent});
  return {jar, writes, local, storage:window.IOYA_AUTH_OPTIONS.auth.storage, clear:window.IOYA_CLEAR_LOGIN_COOKIES, options:window.IOYA_AUTH_OPTIONS};
}
const KEY = 'sb-abc-auth-token';
const session = n => JSON.stringify({access_token:'x'.repeat(n), user:{email:'me@example.com; "quoted" = yes'}});

test('the login is kept in cookies, split into pieces, and read back exactly', () => {
  const b = browser(), value = session(7000);
  b.storage.setItem(KEY, value);
  const names = [...b.jar.keys()];
  assert.deepEqual(names, [`${KEY}.0`, `${KEY}.1`, `${KEY}.2`], 'split into pieces');
  assert.ok([...b.jar.values()].every(v => v.length <= 3000), 'each piece stays under the 4 KB cookie limit');
  assert.equal(b.storage.getItem(KEY), value, 'semicolons, quotes and spaces survive');
  assert.ok(b.writes.every(w => /; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/.test(w)), 'site-wide, SameSite=Lax, Secure on https');
  assert.equal(b.options.auth.persistSession, true);
});

test('a login full of characters that grow when encoded still fits, and escapes are never cut in half', () => {
  const b = browser(), value = JSON.stringify({name:'é"; '.repeat(1500)});
  b.storage.setItem(KEY, value);
  assert.ok(b.jar.size > 3);
  assert.ok([...b.jar.values()].every(v => v.length <= 3000 && !/%.?$/.test(v)), 'no piece ends inside a %XX escape');
  assert.equal(b.storage.getItem(KEY), value);
});

test('a shorter login removes the leftover pieces, and removeItem deletes them all', () => {
  const b = browser();
  b.storage.setItem(KEY, session(7000));
  b.storage.setItem(KEY, session(100));
  assert.deepEqual([...b.jar.keys()], [`${KEY}.0`]);
  assert.equal(b.storage.getItem(KEY), session(100));
  b.storage.removeItem(KEY);
  assert.equal(b.jar.size, 0);
  assert.equal(b.storage.getItem(KEY), null);
});

test('on http (localhost) the cookies are not marked Secure, so they still work', () => {
  const b = browser({protocol:'http:'});
  b.storage.setItem(KEY, 'abc');
  assert.match(b.writes[0], /SameSite=Lax$/);
});

test('a guest from before this change keeps their account: the login moves from localStorage to cookies', () => {
  const b = browser({stored:{[KEY]:session(500)}});
  assert.equal(b.storage.getItem(KEY), session(500));
  assert.ok(b.jar.has(`${KEY}.0`), 'now in a cookie');
  assert.equal(b.local.has(KEY), false, 'and gone from localStorage');
});

test('log out clears every Supabase login cookie and leaves other cookies alone', () => {
  const b = browser();
  b.storage.setItem(KEY, session(7000));
  b.jar.set('theme', 'dark');
  b.clear();
  assert.deepEqual([...b.jar.keys()], ['theme']);
});
