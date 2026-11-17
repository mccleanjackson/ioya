// The OKR page: /okrs shows the team's 4 key results, live, for anyone (no login).
// The page is public/okrs.html; it loads the numbers from /api/okrs every few seconds. Only
// okr_stats() is called here, with the anon key: it returns totals only (see supabase/okrs.sql).
const path = require('path');
const express = require('express');

const PREVIEW_STATS = {
  kr1: {splits: 8, fully_paid: 5},
  kr2: {splits: 3, owed_cents: 12400, paid_cents: 4650},
  kr3: {hours: 24, people: 14, on_time: 11},
  kr4: {paid: 15, average_seconds: 5 * 3600 + 20 * 60}
};

const count = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// Turns okr_stats()'s totals into what the page shows. Percentages have one decimal place;
// null means "no data yet".
function okrSummary(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const kr1 = s.kr1 || {}, kr2 = s.kr2 || {}, kr3 = s.kr3 || {}, kr4 = s.kr4 || {};
  const splits = count(kr1.splits), fullyPaid = Math.min(count(kr1.fully_paid), splits);
  const owed = count(kr2.owed_cents), paid = Math.min(count(kr2.paid_cents), owed);
  const people = count(kr3.people), onTime = Math.min(count(kr3.on_time), people);
  const paidCount = count(kr4.paid);
  const seconds = paidCount && kr4.average_seconds != null ? count(kr4.average_seconds) : null;
  return {
    kr1: {percent: percent(fullyPaid, splits), fullyPaid, splits},
    kr2: {percent: percent(paid, owed), paidCents: paid, owedCents: owed, splits: count(kr2.splits)},
    kr3: {percent: percent(onTime, people), onTime, people, hours: count(kr3.hours) || 24},
    kr4: {seconds, paid: paidCount},
    updatedAt: new Date().toISOString()
  };
}

function okrs({preview, supabaseUrl, supabaseAnonKey, publicDir}) {
  const router = express.Router();
  router.get(['/okrs', '/okrs/'], (req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    });
    res.sendFile(path.join(publicDir, 'okrs.html'));
  });
  router.get('/api/okrs', async (req, res) => {
    res.set({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    try {
      let raw = PREVIEW_STATS;
      if (!preview) {
        const response = await fetch(new URL('/rest/v1/rpc/okr_stats', supabaseUrl), {
          method: 'POST',
          headers: {apikey: supabaseAnonKey, Authorization: 'Bearer ' + supabaseAnonKey, 'Content-Type': 'application/json'},
          body: '{}'
        });
        if (response.status === 404) return res.status(503).json({error: 'The OKR numbers need a database update: run supabase/okrs.sql in Supabase.'});
        if (!response.ok) throw new Error('okr_stats ' + response.status);
        raw = await response.json();
      }
      res.json(okrSummary(raw));
    } catch {
      res.status(503).json({error: 'The OKR numbers are unavailable right now. Try again in a moment.'});
    }
  });
  return router;
}

module.exports = {okrs, okrSummary};
