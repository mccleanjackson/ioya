// /qr.png: a QR code for the site's own landing page, shown on the landing page (laptops) so people
// can scan it from a screen or projector and open IOYA on their phone.
// It holds the public address (IOYA_PUBLIC_ORIGIN, or Render's RENDER_EXTERNAL_URL); when running on
// your own computer it holds the localhost address you opened. Any other Host gets a 404, so a made-up
// Host header can't put another site in the code.
const express = require('express');
const QRCode = require('qrcode');

function siteQr({publicOrigin}) {
  const router = express.Router();
  const cache = new Map();
  router.get('/qr.png', async (req, res) => {
    let origin = publicOrigin;
    if (!origin && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.get('host') || '')) origin = `http://${req.get('host')}`;
    if (!origin) return res.sendStatus(404);
    const url = new URL('/', origin).href;
    if (!cache.has(url)) cache.set(url, await QRCode.toBuffer(url, {width: 360, margin: 2}));
    res.set({'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff'}).type('png').send(cache.get(url));
  });
  return router;
}

module.exports = {siteQr};
