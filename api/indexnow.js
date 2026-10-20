// Pings IndexNow (Bing, Yandex and other participating search engines) with every
// URL in sitemap.xml. Open https://getdumphero.com/api/indexnow in a browser after
// publishing site changes. The key file lives at /<KEY>.txt in the site root.

const KEY = 'bdbe99645974d3002d484c65d1df3d69';
const HOST = 'getdumphero.com';

module.exports = async (req, res) => {
  try {
    const sm = await fetch(`https://${HOST}/sitemap.xml`).then(r => r.text());
    const urlList = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).slice(0, 10000);
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList })
    });
    const ok = r.status === 200 || r.status === 202;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(ok ? 200 : 502).send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>IndexNow</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">` +
      (ok
        ? `<h1>Done ✅</h1><p>Sent ${urlList.length} pages to IndexNow (Bing and partners). Response code ${r.status}.</p>`
        : `<h1>Something went wrong</h1><p>IndexNow answered with code ${r.status}. Try again in a few minutes.</p>`) +
      `</body>`
    );
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
};
