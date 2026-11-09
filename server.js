// Serves the IOYA frontend and routes payment links to Supabase.
require('dotenv').config();
const path = require('path');
const express = require('express');
const {manualPaymentRequests} = require('./manual-payment-requests');

const {SUPABASE_URL, SUPABASE_ANON_KEY, IOYA_PUBLIC_ORIGIN, RENDER_EXTERNAL_URL} = process.env;
const preview = process.env.IOYA_PREVIEW === '1';
if (!preview && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

const app = express();
const publicDir = path.join(__dirname, 'public');

function configuredOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const publicHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(hostname)
      && !/\.(?:local|localhost|internal|test|invalid|example|onion)$/.test(hostname);
    if (publicHost && url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
      return url.origin;
    }
  } catch { /* Invalid origins leave payment links disabled. */ }
  return null;
}

if (preview) app.use((req, res, next) => {
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.get('host') || '')) return res.sendStatus(403);
  next();
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store');
  const config = preview ? {preview: true} : {supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY};
  res.send(`window.IOYA_CONFIG = ${JSON.stringify(config)};`);
});

app.use('/api/manual-requests', manualPaymentRequests({
  preview, supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY,
  publicOrigin: configuredOrigin(IOYA_PUBLIC_ORIGIN || RENDER_EXTERNAL_URL)
}));
app.get(['/pay', '/pay.html'], (req, res) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  });
  res.sendFile(path.join(publicDir, 'pay.html'));
});
app.use(express.static(publicDir));

const port = Number(process.env.PORT) || 3001;
const host = preview ? '127.0.0.1' : undefined;
app.listen(port, host, () => console.log(`IOYA running at http://${host || 'localhost'}:${port}`));
