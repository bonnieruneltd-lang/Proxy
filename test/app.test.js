'use strict';

const http = require('node:http');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/server');
const { normalizeConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { listen, close, request, startMockDoh, mockResolver, ZONE } = require('./helpers');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000a49444154789c6360000002000100ffff0300000600'
  + '0557bfabd40000000049454e44ae426082',
  'hex'
);

const PAGE_ONE = `<!doctype html><html><head><title>Home page</title>
<link rel="stylesheet" href="/style.css">
</head><body><h1>Hello from upstream</h1>
<a href="/page2">page two</a>
<img src="/logo.png" alt="logo">
<form action="/submit" method="post"><input name="field" value="value"></form>
</body></html>`;

function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });

      if (req.url === '/') {
        const gzipped = zlib.gzipSync(Buffer.from(PAGE_ONE));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
          'content-length': gzipped.length,
          'content-security-policy': "default-src 'none'",
          'x-frame-options': 'DENY',
          'set-cookie': 'tracker=1; Path=/'
        });
        res.end(gzipped);
        return;
      }
      if (req.url.startsWith('/page2')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Page two</title></head><body><p>Page two body</p></body></html>');
        return;
      }
      if (req.url === '/style.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('.logo { background: url("/logo.png"); }');
        return;
      }
      if (req.url === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'x-frame-options': 'DENY' });
        res.end(PNG);
        return;
      }
      if (req.url.startsWith('/submit')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><head><title>Submitted</title></head><body><p>got ${body || req.url}</p></body></html>`);
        return;
      }
      if (req.url === '/plain.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('just text');
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/page2' });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
  });
  return { server, seen };
}

async function startApp(upstreamPort) {
  const { server: dohServer } = startMockDoh({
    zone: { ...ZONE, 'site.test': { A: ['127.0.0.1'] } }
  });
  const dohPort = await listen(dohServer);
  const resolver = mockResolver(`http://127.0.0.1:${dohPort}/dns-query`);
  const config = {
    ...normalizeConfig([]),
    host: '127.0.0.1',
    port: 0,
    socks: false,
    ui: true,
    logLevel: 'silent',
    timeout: 3000,
    maxBodyBytes: 2 * 1024 * 1024,
    benchRounds: 2,
    benchHost: 'example.com'
  };
  config.pacHost = null;
  config.lanAddress = '192.168.1.50';

  const app = createApp(config, { logger: createLogger('silent'), resolver });
  await app.start();
  return {
    app,
    base: `http://127.0.0.1:${app.address().port}`,
    upstream: `http://site.test:${upstreamPort}`,
    dohServer
  };
}

test('homepage, status, PAC and health endpoints work', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const home = await request(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.ok(home.text.includes('id="address-form"'));
  assert.ok(home.text.includes('wififree'));

  const status = await request(`${base}/api/status`);
  assert.equal(status.status, 200);
  const json = JSON.parse(status.text);
  assert.equal(json.proxy.port, app.address().port);
  assert.equal(json.socks, null);
  assert.equal(json.ui.enabled, true);
  assert.ok(json.pac.url.endsWith('/proxy.pac'));
  assert.equal(json.resolver.resolvers[0].id, 'mock');
  assert.ok(json.quickLinks.length >= 4);

  const pac = await request(`${base}/proxy.pac`);
  assert.equal(pac.status, 200);
  assert.match(pac.headers['content-type'], /x-ns-proxy-autoconfig/);
  assert.ok(pac.text.includes('FindProxyForURL'));
  assert.ok(pac.text.includes(`PROXY 127.0.0.1:${app.address().port}`));
  assert.ok(pac.text.includes('return "DIRECT"'));
  assert.ok(pac.text.includes('connectivitycheck.gstatic.com'));

  const socksPac = await request(`${base}/proxy.pac?type=socks5`);
  assert.ok(socksPac.text.includes(`SOCKS5 127.0.0.1:${app.config.socksPort}`));

  const health = await request(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.text.trim(), 'ok');

  const missing = await request(`${base}/nope`);
  assert.equal(missing.status, 404);

  const rb = await request(`${base}/robots.txt`);
  assert.equal(rb.status, 200);
  assert.match(rb.text, /Disallow/);
});

test('/browse rewrites HTML, strips CSP and decodes gzip', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, upstream: upstreamUrl, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const target = `${upstreamUrl}/`;
  const page = await request(`${base}/browse?url=${encodeURIComponent(target)}`);

  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['content-security-policy'], undefined);
  assert.equal(page.headers['set-cookie'], undefined, 'upstream cookies must not leak');
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.ok(page.text.includes('Hello from upstream'), 'gzip body is decoded');
  assert.ok(page.text.includes('id="wf-bar"'), 'browser chrome is injected');

  const link = page.text.match(/href="(\/browse\?url=[^"]+)"/);
  assert.ok(link, 'links point back at the client');
  assert.ok(link[1].includes(encodeURIComponent(`${upstreamUrl}/page2`)));
  assert.ok(page.text.includes(`src="/raw?url=${encodeURIComponent(`${upstreamUrl}/logo.png`)}"`));
  assert.ok(page.text.includes('loading="lazy"'));
  assert.ok(page.text.includes(`href="/raw?url=${encodeURIComponent(`${upstreamUrl}/style.css`)}"`));

  const second = await request(`${base}${link[1].replace(/&amp;/g, '&')}`);
  assert.equal(second.status, 200);
  assert.ok(second.text.includes('Page two body'));

  const redirected = await request(`${base}/browse?url=${encodeURIComponent(`${upstreamUrl}/redirect`)}`);
  assert.equal(redirected.status, 200);
  assert.ok(redirected.text.includes('Page two body'));
});

test('/raw streams assets byte-for-byte and rewrites CSS', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, upstream: upstreamUrl, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const image = await request(`${base}/raw?url=${encodeURIComponent(`${upstreamUrl}/logo.png`)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-frame-options'], undefined);
  assert.ok(image.body.equals(PNG), 'asset bytes are untouched');

  const css = await request(`${base}/raw?url=${encodeURIComponent(`${upstreamUrl}/style.css`)}`);
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.ok(css.text.includes(`/raw?url=${encodeURIComponent(`${upstreamUrl}/logo.png`)}`));

  const missing = await request(`${base}/raw`);
  assert.equal(missing.status, 400);

  const badScheme = await request(`${base}/raw?url=${encodeURIComponent('file:///etc/passwd')}`);
  assert.equal(badScheme.status, 400);
});

test('/browse forwards POST bodies and merges GET form fields', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, upstream: upstreamUrl, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const target = `${upstreamUrl}/submit`;
  const posted = await request(`${base}/browse?url=${encodeURIComponent(target)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': 11 },
    body: 'field=value'
  });
  assert.equal(posted.status, 200);
  assert.ok(posted.text.includes('got field=value'));
  const upstreamSeen = upstream.seen.find((entry) => entry.method === 'POST');
  assert.equal(upstreamSeen.url, '/submit');
  assert.equal(upstreamSeen.body, 'field=value');

  const getForm = await request(
    `${base}/browse?__url=${encodeURIComponent(`${target}?x=1`)}&q=hello`
  );
  assert.equal(getForm.status, 200);
  assert.ok(getForm.text.includes('got'), 'GET form submission is forwarded');
  const getSeen = upstream.seen.find((entry) => entry.url === '/submit?x=1&q=hello');
  assert.ok(getSeen, `expected /submit?x=1&q=hello, saw ${upstream.seen.map((e) => e.url).join(', ')}`);
});

test('/browse validates input and redirects non-HTML to /raw', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, upstream: upstreamUrl, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const empty = await request(`${base}/browse`);
  assert.equal(empty.status, 400);

  const invalid = await request(`${base}/browse?url=not-a-url`);
  assert.equal(invalid.status, 400);

  const ftp = await request(`${base}/browse?url=${encodeURIComponent('ftp://x.example/')}`);
  assert.equal(ftp.status, 400);

  const plain = await request(`${base}/browse?url=${encodeURIComponent(`${upstreamUrl}/plain.txt`)}`);
  assert.equal(plain.status, 302);
  assert.ok(plain.headers.location.startsWith('/raw?url='));

  const unreachable = await request(
    `${base}/browse?url=${encodeURIComponent('http://127.0.0.1:1/')}`,
    { timeout: 5000 }
  );
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.text, /Could not load that page/);
});

test('/api/bench and /api/resolve expose resolver internals', async (t) => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, dohServer } = await startApp(upstreamPort);
  t.after(async () => {
    await app.close();
    await close(upstream.server);
    await close(dohServer);
  });

  const bench = await request(`${base}/api/bench?rounds=2`);
  assert.equal(bench.status, 200);
  const benchJson = JSON.parse(bench.text);
  assert.equal(benchJson.fastest, 'mock');
  assert.equal(benchJson.results.length, 1);
  assert.equal(typeof benchJson.results[0].medianMs, 'number');

  const resolved = await request(`${base}/api/resolve?name=example.com`);
  assert.equal(resolved.status, 200);
  const resolvedJson = JSON.parse(resolved.text);
  const resolvedAddresses = resolvedJson.addresses.map((a) => a.address);
  assert.ok(resolvedAddresses.includes('93.184.216.34'));

  const bad = await request(`${base}/api/resolve`);
  assert.equal(bad.status, 400);

  const hosts = await request(`${base}/api/hosts`);
  assert.equal(hosts.status, 200);
  assert.ok(Array.isArray(JSON.parse(hosts.text).hosts));
});

test('app.close() releases ports and sockets', async () => {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const { app, base, dohServer } = await startApp(upstreamPort);
  const port = app.address().port;

  await request(`${base}/browse?url=${encodeURIComponent(`http://site.test:${upstreamPort}/`)}`);
  await app.close();
  await close(upstream.server);
  await close(dohServer);

  await assert.rejects(() => request(`${base}/health`, { timeout: 1000 }));
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await close(probe);
});
