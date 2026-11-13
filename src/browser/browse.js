'use strict';

const { openUpstream, decompress, readAll, decodeText, isHtml, isCss } = require('./fetch');
const { rewriteHtml } = require('./html');
const { rewriteCss, escapeAttr } = require('./rewrite');

const STRIP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'report-to',
  'nel',
  'clear-site-data',
  'content-length'
]);

const BAR_CSS = `
#wf-bar{position:fixed!important;top:0!important;left:0!important;right:0!important;z-index:2147483647!important;
display:flex!important;align-items:center!important;gap:6px!important;height:44px!important;padding:0 8px!important;
box-sizing:border-box!important;background:#101318!important;color:#e8eef7!important;
font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;
box-shadow:0 1px 0 #0006,0 6px 18px #0003!important;direction:ltr!important;text-align:left!important}
#wf-bar *{box-sizing:border-box!important;font:inherit!important;color:inherit!important}
#wf-bar button,#wf-bar a.wf-btn{background:#1c222b!important;border:1px solid #2c3542!important;border-radius:7px!important;
height:30px!important;min-width:30px!important;padding:0 8px!important;cursor:pointer!important;text-decoration:none!important;
display:inline-flex!important;align-items:center!important;justify-content:center!important}
#wf-bar button:hover,#wf-bar a.wf-btn:hover{background:#26303c!important}
#wf-bar form{flex:1 1 auto!important;display:flex!important;gap:6px!important;margin:0!important;min-width:0!important}
#wf-bar input{flex:1 1 auto!important;min-width:0!important;height:30px!important;border-radius:7px!important;
border:1px solid #2c3542!important;background:#0a0d11!important;padding:0 10px!important;outline:none!important}
#wf-bar input:focus{border-color:#3b82f6!important}
#wf-bar .wf-go{background:#2563eb!important;border-color:#2563eb!important;color:#fff!important;padding:0 14px!important}
#wf-bar .wf-host{opacity:.6!important;max-width:22ch!important;overflow:hidden!important;text-overflow:ellipsis!important;
white-space:nowrap!important;font-size:12px!important}
@media(max-width:520px){#wf-bar .wf-host{display:none!important}}
body{padding-top:44px!important}
`;

function toolbarHtml(pageUrl) {
  const safe = escapeAttr(pageUrl);
  let host = '';
  try {
    host = new URL(pageUrl).host;
  } catch (err) {
    host = '';
  }
  return `<style id="wf-style">${BAR_CSS}</style>`
    + `<div id="wf-bar" role="navigation" aria-label="wififree browser">`
    + '<button type="button" onclick="history.back()" title="Back">&lsaquo;</button>'
    + '<button type="button" onclick="history.forward()" title="Forward">&rsaquo;</button>'
    + '<button type="button" onclick="location.reload()" title="Reload">&#8635;</button>'
    + '<a class="wf-btn" href="/" title="wififree home">&#8962;</a>'
    + '<form action="/browse" method="get" autocomplete="off">'
    + `<input type="text" name="url" value="${safe}" spellcheck="false" aria-label="Address">`
    + '<button class="wf-go" type="submit">Go</button>'
    + '</form>'
    + `<span class="wf-host" title="${escapeAttr(host)}">${escapeAttr(host)}</span>`
    + `<a class="wf-btn" href="/raw?url=${encodeURIComponent(pageUrl)}" target="_blank" rel="noreferrer" title="Open without rewriting">raw</a>`
    + '</div>';
}

function injectChrome(html, { pageUrl }) {
  const bar = toolbarHtml(pageUrl);
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  let doc = String(html);
  const needsViewport = !/<meta[^>]+name=["']?viewport/i.test(doc);
  const hasHead = /<head[^>]*>/i.test(doc);
  const hasBody = /<body[^>]*>/i.test(doc);

  if (hasBody) {
    if (needsViewport) {
      if (hasHead) doc = doc.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>${viewport}`);
      else doc = viewport + doc;
    }
    doc = doc.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${bar}`);
    return doc;
  }

  // Fragments (or documents missing <body>): viewport first, then the toolbar.
  return `${needsViewport ? viewport : ''}${bar}${doc}`;
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}


function errorPage({ title, message, url, details }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0e12;color:#e6edf6;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:560px;width:100%;background:#121821;border:1px solid #22303f;border-radius:16px;padding:24px}
h1{margin:0 0 8px;font-size:19px}
p{margin:0 0 14px;color:#a7b4c6}
code{display:block;background:#0a0f15;border:1px solid #1f2a36;border-radius:10px;padding:10px 12px;
font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fd0ff;word-break:break-all;margin-bottom:14px}
a.btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:9px 16px;border-radius:9px;font-weight:600}
a.ghost{background:transparent;color:#9fb2c9;margin-left:8px}
</style></head><body><div class="card">
<h1>${escapeAttr(title)}</h1>
<p>${escapeAttr(message)}</p>
${url ? `<code>${escapeAttr(url)}</code>` : ''}
${details ? `<p style="font-size:13px;color:#7d8ea3">${escapeAttr(details)}</p>` : ''}
<a class="btn" href="/">wififree home</a>
<a class="btn ghost" href="/browse?url=${encodeURIComponent('https://example.com')}">test example.com</a>
</div></body></html>`;
}

function responseHeaders(upstream) {
  const headers = {};
  for (const [key, value] of Object.entries(upstream.headers || {})) {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

function pickForwardHeaders(req) {
  const out = {};
  for (const name of ['content-type', 'accept', 'accept-language', 'accept-encoding']) {
    if (req.headers[name]) out[name] = req.headers[name];
  }
  return out;
}

function readBody(req, limit) {
  return readAll(req, limit);
}

/**
 * Handles /browse: fetch a page, rewrite it and inject the browser chrome.
 */
async function handleBrowse(req, res, ctx) {
  const { query, resolver, timeout, maxBytes, logger, stats, agents } = ctx;

  let target = query.get('url');
  if (!target && query.get('__url')) {
    try {
      const formTarget = new URL(query.get('__url'));
      for (const [key, value] of query) {
        if (key === '__url' || key === 'url') continue;
        formTarget.searchParams.append(key, value);
      }
      target = formTarget.href;
    } catch (err) {
      sendHtml(res, 400, errorPage({
        title: 'Invalid form target',
        message: 'The hidden form target was not a valid URL.',
        url: query.get('__url')
      }));
      return;
    }
  }

  if (!target) {
    sendHtml(res, 400, errorPage({
      title: 'Nothing to browse',
      message: 'Pass ?url=https://example.com to this endpoint.'
    }));
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    sendHtml(res, 400, errorPage({ title: 'Invalid URL', message: 'That address could not be parsed.', url: target }));
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendHtml(res, 400, errorPage({
      title: 'Unsupported address',
      message: 'Only http:// and https:// addresses can be browsed.',
      url: target
    }));
    return;
  }

  const method = req.method === 'POST' ? 'POST' : 'GET';
  let body = null;
  try {
    if (method === 'POST') body = await readBody(req, maxBytes);
  } catch (err) {
    sendHtml(res, 413, errorPage({ title: 'Request too large', message: err.message, url: target }));
    return;
  }

  stats.requests += 1;
  stats.recordHost(parsed.hostname);

  try {
    const { res: upstream, finalUrl } = await openUpstream({
      url: target,
      method,
      headers: pickForwardHeaders(req),
      body,
      resolver,
      timeout,
      agents,
      redirects: 5
    });

    const contentType = upstream.headers['content-type'] || '';
    if (!isHtml(contentType)) {
      upstream.resume();
      res.writeHead(302, {
        location: `/raw?url=${encodeURIComponent(finalUrl)}`,
        'cache-control': 'no-store'
      });
      res.end();
      return;
    }

    const decoded = decompress(upstream, upstream.headers['content-encoding']);
    const raw = await readAll(decoded, maxBytes);
    const text = decodeText(raw, contentType);
    const { html, title } = rewriteHtml(text, finalUrl, { browsePath: '/browse', rawPath: '/raw' });
    const page = injectChrome(html, { pageUrl: finalUrl, title });
    sendHtml(res, upstream.statusCode || 200, page);
  } catch (err) {
    logger.debug(`browse ${target} failed: ${err.stack || err.message}`);
    stats.errors += 1;
    sendHtml(res, 502, errorPage({
      title: 'Could not load that page',
      message: err.message,
      url: target,
      details: 'The proxy could not reach the site. Try again, or check the proxy/PAC settings on the home page.'
    }));
  }
}

/**
 * Handles /raw: streams assets (images, JS, CSS) through the proxy.
 * CSS is rewritten so its url() references keep working.
 */
async function handleRaw(req, res, ctx) {
  const { query, resolver, timeout, maxBytes, logger, stats, agents } = ctx;
  const target = query.get('url');

  let parsed;
  try {
    parsed = new URL(target || '');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('wififree: /raw requires ?url=https://...\n');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('wififree: only http:// and https:// URLs are supported\n');
    return;
  }

  stats.requests += 1;
  stats.recordHost(parsed.hostname);

  try {
    const { res: upstream, finalUrl } = await openUpstream({
      url: parsed.href,
      method: 'GET',
      headers: pickForwardHeaders(req),
      resolver,
      timeout,
      agents,
      redirects: 5
    });

    const headers = responseHeaders(upstream);
    const contentType = upstream.headers['content-type'] || '';

    if (isCss(contentType)) {
      const raw = await readAll(decompress(upstream, upstream.headers['content-encoding']), maxBytes);
      const css = rewriteCss(decodeText(raw, contentType), finalUrl, (abs) => `/raw?url=${encodeURIComponent(abs)}`);
      const body = Buffer.from(css, 'utf8');
      delete headers['transfer-encoding'];
      delete headers.connection;
      res.writeHead(upstream.statusCode || 200, {
        ...headers,
        'content-type': 'text/css; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'public, max-age=120',
        'x-content-type-options': 'nosniff'
      });
      res.end(body);
      return;
    }

    headers['cache-control'] = 'public, max-age=120';
    res.writeHead(upstream.statusCode || 200, headers);
    upstream.on('data', (chunk) => { stats.bytesDown += chunk.length; });
    upstream.on('error', (err) => {
      logger.debug(`raw stream failed for ${finalUrl}: ${err.message}`);
      res.destroy();
    });
    upstream.pipe(res);
  } catch (err) {
    logger.debug(`raw ${parsed.href} failed: ${err.message}`);
    stats.errors += 1;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`wififree: could not fetch ${parsed.href}: ${err.message}\n`);
  }
}

module.exports = {
  handleBrowse,
  handleRaw,
  injectChrome,
  toolbarHtml,
  sendHtml,
  errorPage,
  responseHeaders,
  pickForwardHeaders,
  STRIP_RESPONSE_HEADERS,
  BAR_CSS
};
