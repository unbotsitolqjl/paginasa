const http = require('http');
const url  = require('url');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const PROXY_URL  = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PROXY_URL || `http://localhost:${PORT}`);
const EMBED_BASE = 'https://embed.st/embed-noads/admin';

let browser = null, page = null, currentEmbed = null, browserReady = false;

// Arranca el servidor PRIMERO, luego inicia Chrome
async function initBrowser() {
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    });
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (['image','font','stylesheet'].includes(req.resourceType()) ||
          u.includes('tiktok') || u.includes('google') || u.includes('facebook')) {
        req.abort();
      } else req.continue();
    });
    browserReady = true;
    console.log('[puppeteer] Listo');
  } catch (e) {
    console.error('[puppeteer] Error al iniciar:', e.message);
  }
}

async function ensureEmbed(slug, embedId) {
  const key = `${slug}/${embedId}`;
  if (currentEmbed !== key) {
    await page.goto(`${EMBED_BASE}/${slug}/${embedId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    currentEmbed = key;
    console.log(`[embed] Cargado ${key}`);
  }
}

async function fetchViaPage(targetUrl) {
  return page.evaluate(async u => {
    try {
      const r = await fetch(u, { headers: { Accept: '*/*' }, mode: 'cors' });
      if (!r.ok) return { ok: false, status: r.status };
      const ct  = r.headers.get('content-type') || '';
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      return { ok: true, ct, b64: btoa(bin) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, targetUrl);
}

function rewriteM3u8(text, baseUrl) {
  const origin = new URL(baseUrl).origin;
  return text.split('\n').map(line => {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      let abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseUrl + t;
      try {
        return new URL(abs).hostname.endsWith('strmd.st')
          ? `${PROXY_URL}/proxy?url=${encodeURIComponent(abs)}`
          : abs;
      } catch { return line; }
    }
    return line;
  }).join('\n');
}

// ── Siempre poner CORS antes de writeHead ────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  cors(res); // SIEMPRE primero

  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('DROP VAULT Proxy ' + (browserReady ? '✅' : '⏳ iniciando...'));
  }

  // /load
  if (p === '/load') {
    const { slug, id = '1' } = parsed.query;
    if (!slug) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false })); }
    if (!browserReady) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, note: 'browser warming up' })); }
    try {
      await ensureEmbed(slug, id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // /proxy
  if (p === '/proxy') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) { res.writeHead(400); return res.end('Missing url'); }
    let ph;
    try { ph = new URL(targetUrl); } catch { res.writeHead(400); return res.end('Invalid url'); }
    if (!ph.hostname.endsWith('strmd.st')) { res.writeHead(403); return res.end('Not allowed'); }
    if (!browserReady) { res.writeHead(503); return res.end('Browser not ready yet, retry in a few seconds'); }

    try {
      const result = await fetchViaPage(targetUrl);
      if (!result.ok) {
        const msg = `Upstream error - status: ${result.status || 'N/A'}, error: ${result.error || 'none'}, url: ${targetUrl.slice(0,80)}`;
        console.error('[proxy]', msg);
        res.writeHead(502); return res.end(msg);
      }
      const body = Buffer.from(result.b64, 'base64');
      const ct   = result.ct || 'application/octet-stream';
      const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') || targetUrl.includes('playlist');
      if (isM3u8) {
        const base  = targetUrl.slice(0, targetUrl.lastIndexOf('/') + 1);
        const rw    = Buffer.from(rewriteM3u8(body.toString('utf8'), base));
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': rw.length });
        return res.end(rw);
      }
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length });
      return res.end(body);
    } catch (e) { res.writeHead(502); return res.end('Proxy error: ' + e.message); }
  }

  res.writeHead(404); res.end('Not found');
});

// Arranca el servidor inmediatamente, luego inicia Chrome en paralelo
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  initBrowser(); // no await — corre en background
});
