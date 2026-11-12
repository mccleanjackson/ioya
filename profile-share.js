// Public profile pages: /u/<code> shows someone's name, photo and payment apps (Profile → Share my profile).
// The page itself is public/profile.html; it loads the details from /api/u/<code>, and the QR picture
// comes from /api/u/<code>/qr. Only read_profile() is called here, with the anon key: it returns just
// the public details (see supabase/profile-share.sql).
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const codePattern = /^[a-z2-9]{10}$/;
const avatarPattern = /^[0-9a-f-]{36}\/[A-Za-z0-9-]{8,64}\.jpg$/;
const PREVIEW_PROFILE = {first: 'Preview', last: 'Person', avatar_path: null,
  accounts: {venmo: 'Preview-Person', zelle: '+18015550100'}, preferred: 'venmo'};

function failure(status, message) {
  return Object.assign(new Error(message), {status});
}
const missing = () => failure(404, 'This profile link isn\'t working. Ask for a new one.');

function profileShare({preview, supabaseUrl, supabaseAnonKey, publicOrigin, publicDir}) {
  const supabaseOrigin = !preview && supabaseUrl ? new URL(supabaseUrl).origin : '';

  async function readProfile(code) {
    if (!codePattern.test(code)) throw missing();
    let profile;
    if (preview) profile = code === 'preview2ab' ? PREVIEW_PROFILE : null;
    else {
      const response = await fetch(new URL('/rest/v1/rpc/read_profile', supabaseUrl), {
        method: 'POST',
        headers: {apikey: supabaseAnonKey, Authorization: 'Bearer ' + supabaseAnonKey, 'Content-Type': 'application/json'},
        body: JSON.stringify({p_code: code})
      });
      if (!response.ok) throw failure(503, 'Profiles are unavailable right now. Try again later.');
      profile = await response.json();
    }
    if (!profile || typeof profile !== 'object') throw missing();
    const avatar = typeof profile.avatar_path === 'string' && avatarPattern.test(profile.avatar_path) ? profile.avatar_path : null;
    return {
      first: String(profile.first || ''),
      last: String(profile.last || ''),
      avatarUrl: avatar && supabaseOrigin ? `${supabaseOrigin}/storage/v1/object/public/avatars/${avatar}` : null,
      accounts: profile.accounts && typeof profile.accounts === 'object' ? profile.accounts : {},
      preferred: typeof profile.preferred === 'string' ? profile.preferred : null
    };
  }

  // The address inside the QR code. On Render this is the site's public address; when running on
  // your own computer it's the localhost address you opened.
  function profileUrl(req, code) {
    let origin = publicOrigin;
    if (!origin && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.get('host') || '')) origin = `http://${req.get('host')}`;
    if (!origin) throw failure(503, 'Set IOYA_PUBLIC_ORIGIN to enable profile links.');
    return new URL('/u/' + code, origin).href;
  }

  const router = express.Router();
  router.get('/u/:code', (req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'${supabaseOrigin ? ' ' + supabaseOrigin : ''}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
    });
    res.sendFile(path.join(publicDir, 'profile.html'));
  });
  router.use('/api/u', (req, res, next) => {
    res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'});
    next();
  });
  router.get('/api/u/:code', async (req, res) => {
    res.json(await readProfile(req.params.code));
  });
  router.get('/api/u/:code/qr', async (req, res) => {
    const code = req.params.code;
    const url = profileUrl(req, code);
    await readProfile(code);
    res.type('png').send(await QRCode.toBuffer(url, {width: 320, margin: 4}));
  });
  router.use('/api/u', (error, req, res, next) => {
    res.status(error.status || 503).json({error: error.status ? error.message : 'Profiles are unavailable right now. Try again later.'});
  });
  return router;
}

module.exports = {profileShare};
