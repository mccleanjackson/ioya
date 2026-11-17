const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {okrs, okrSummary} = require('../okrs');

// The OKR page (/okrs, okrs.js + public/okrs.html; numbers from okr_stats() in supabase/okrs.sql).
const publicDir = path.join(__dirname, '../public');
async function serve(t, options) {
  const app = express(); app.use(okrs({publicDir, supabaseUrl: 'https://db.example.com', supabaseAnonKey: 'public-test-key', ...options}));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  try { await once(server, 'listening'); } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
  return `http://127.0.0.1:${server.address().port}`;
}
// Calls to Supabase go to a fake; requests to the test server itself go through.
function fakeSupabase(t, reply) {
  const realFetch = global.fetch, calls = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.com')) { calls.push([String(url), init]); return reply(); }
    return realFetch(url, init);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

test('okrSummary turns the totals into percentages and keeps empty results empty', () => {
  const s = okrSummary({kr1: {splits: 8, fully_paid: 5}, kr2: {splits: 3, owed_cents: 12000, paid_cents: 4000},
    kr3: {hours: 24, people: 3, on_time: 2}, kr4: {paid: 4, average_seconds: 7260}});
  assert.deepEqual(s.kr1, {percent: 62.5, fullyPaid: 5, splits: 8});
  assert.deepEqual(s.kr2, {percent: 33.3, paidCents: 4000, owedCents: 12000, splits: 3});
  assert.deepEqual(s.kr3, {percent: 66.7, onTime: 2, people: 3, hours: 24});
  assert.deepEqual(s.kr4, {seconds: 7260, paid: 4});

  const empty = okrSummary({kr1: {splits: 0, fully_paid: 0}, kr2: {splits: 0, owed_cents: 0, paid_cents: 0}, kr3: {people: 0, on_time: 0}, kr4: {paid: 0, average_seconds: null}});
  assert.equal(empty.kr1.percent, null);
  assert.equal(empty.kr2.percent, null);
  assert.equal(empty.kr3.percent, null);
  assert.equal(empty.kr4.seconds, null);
  assert.equal(okrSummary(null).kr1.splits, 0, 'junk input gives zeros, not a crash');
  assert.equal(okrSummary({kr1: {splits: 2, fully_paid: 9}}).kr1.percent, 100, 'never over 100%');
});

test('/api/okrs reads okr_stats() with the anon key and returns only the summary', async t => {
  const calls = fakeSupabase(t, () => new Response(JSON.stringify({kr1: {splits: 4, fully_paid: 1}, kr2: {splits: 3, owed_cents: 900, paid_cents: 300},
    kr3: {hours: 24, people: 2, on_time: 2}, kr4: {paid: 2, average_seconds: 90}}), {status: 200}));
  const url = await serve(t, {});
  if (!url) return t.skip('This environment blocks loopback HTTP.');
  const res = await fetch(`${url}/api/okrs`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.kr1.percent, 25);
  assert.equal(body.kr2.percent, 33.3);
  assert.equal(body.kr3.percent, 100);
  assert.equal(body.kr4.seconds, 90);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://db.example.com/rest/v1/rpc/okr_stats');
  assert.equal(calls[0][1].headers.apikey, 'public-test-key');
});

test('/api/okrs explains a missing database update and hides other failures', async t => {
  let status = 404;
  fakeSupabase(t, () => new Response('{"message":"Could not find the function public.okr_stats"}', {status}));
  const url = await serve(t, {});
  if (!url) return t.skip('This environment blocks loopback HTTP.');
  let res = await fetch(`${url}/api/okrs`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /run supabase\/okrs.sql/);
  status = 500;
  res = await fetch(`${url}/api/okrs`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'The OKR numbers are unavailable right now. Try again in a moment.');
});

test('preview mode shows sample numbers without Supabase', async t => {
  const calls = fakeSupabase(t, () => { throw new Error('should not be called'); });
  const url = await serve(t, {preview: true});
  if (!url) return t.skip('This environment blocks loopback HTTP.');
  const body = await (await fetch(`${url}/api/okrs`)).json();
  assert.equal(body.kr1.splits, 8);
  assert.equal(calls.length, 0);
});

test('/okrs serves the page with a strict CSP; it shows both objectives and all 4 key results', async t => {
  const url = await serve(t, {});
  if (!url) return t.skip('This environment blocks loopback HTTP.');
  const res = await fetch(`${url}/okrs`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*connect-src 'self'/);
  const html = await res.text();
  assert.match(html, /Objective A<\/span>Increase the % of people who pay back the payer/);
  assert.match(html, /Objective B<\/span>Decrease the time it takes a group to pay back the payer/);
  for (const id of ['kr1', 'kr2', 'kr3', 'kr4']) assert.match(html, new RegExp(`<article class="card" id="${id}">`));
  assert.match(html, /How to move it:/);
  assert.match(html, /const REFRESH_MS = 5000/);
  assert.doesNotMatch(html, /innerHTML/, 'numbers are written with textContent');
});

test('the landing page links to the OKR page', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<a class="hide-sm" href="\/okrs">OKRs<\/a>/);
  assert.match(html, /<a href="\/okrs">Our OKRs<\/a>/);
});

test('okrs.sql adds the times, the paid-time trigger and the totals-only function', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/okrs.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  assert.ok(schema.includes(sql.trim()), 'schema.sql has the same SQL');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS created_at timestamptz;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS paid_at timestamptz;/);
  assert.match(sql, /CREATE TRIGGER participants_paid_at BEFORE INSERT OR UPDATE ON participants/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION okr_stats\(\) TO anon, authenticated;/);
});
