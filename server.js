// Serves the IOYA frontend. All data lives in Supabase; this server only
// hands the browser the Supabase URL and public (anon) key from .env, so neither is committed.
require('dotenv').config();
const path = require('path');
const express = require('express');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

const app = express();

app.get('/config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(`window.IOYA_CONFIG = ${JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY })};`);
});

app.use(express.static(path.join(__dirname, 'public')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`IOYA running at http://localhost:${port}`));
