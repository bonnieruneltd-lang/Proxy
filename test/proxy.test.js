'use strict';

const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttpProxy, splitHostPort, basicCredentials } = require('../src/proxy/http');
const { createSocks5Server } = require('../src/proxy/socks5');
const { createStats } = require('../src/server');
const { createLogger } = require('../src/log');
const { listen, close, connectTunnel, startMockDoh, mockResolver } = require('./helpers');

const logger = createLogger('silent');

function readExactly(socket, size) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= size) {
        socket.removeListener('data', onData);
        resolve(buffer.subarray(0, size));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('socket closed before reply')));
  });
}

function echoServer() {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  return server;
}

async function startProxy({ auth = null, resolver } = {}) {
  const proxy = createHttpProxy({
    resolver,
    auth,
    timeout: 3000,
    stats: createStats(),
    logger
  });
  const server = http.createServer((req, res) => proxy.handleHttp(req, res));
  server.on('connect', (req, socket, head) => proxy.handleConnect(req, socket, head));
  const port = await listen(server);
  return { server, proxy, port };
}

test('splitHostPort handles IPv4, hostnames and IPv6', () => {
  assert.deepEqual(splitHostPort('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(splitHostPort('example.com'), { host: 'example.com', port: 443 });
  assert.deepEqual(splitHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  assert.equal(splitHostPort('example.com:0'), null);
  assert.equal(splitHostPort(''), null);
});

test('basicCredentials decodes Proxy-Authorization', () => {
  const header = `Basic ${Buffer.from('user:pa:ss').toString('base64')}`;
  assert.deepEqual(basicCredentials(header), { user: 'user', pass: 'pa:ss' });
  assert.equal(basicCredentials('Bearer abc'), null);
  assert.equal(basicCredentials(undefined), null);
});

test('HTTP proxy forwards absolute-URI requests and bodies', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const upstreamPort = await listen(upstream);
  const { server, port } = await startProxy({ resolver: mockResolver('http://127.0.0.1:9/dns-query') });

  t.after(async () => {
    await close(upstream);
    await close(server);
  });

  const getResponse = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `http://127.0.0.1:${upstreamPort}/hello/world?x=1`,
      headers: { host: `127.0.0.1:${upstreamPort}`, 'proxy-connection': 'keep-alive' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers['x-upstream'], 'yes');
  assert.equal(JSON.parse(getResponse.body).path, '/hello/world?x=1');
  assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`);

  const postStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `http://127.0.0.1:${upstreamPort}/submit`,
      headers: { 'content-type': 'text/plain', 'content-length': 5 }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('hello');
  });

  assert.equal(postStatus, 200);
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, 'hello');
});

test('HTTP proxy returns 502 when the upstream refuses', async (t) => {
  const { server, port } = await startProxy({ resolver: mockResolver('http://127.0.0.1:9/dns-query') });
  t.after(() => close(server));

  const closed = net.createServer();
  const closedPort = await listen(closed);
  await close(closed);

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `http://127.0.0.1:${closedPort}/nothing`,
      headers: { host: `127.0.0.1:${closedPort}` }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(response.status, 502);
  assert.match(response.body, /ECONNREFUSED|failed/i);
});

test('CONNECT tunnels raw bytes both ways', async (t) => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const { server, port } = await startProxy({ resolver: mockResolver('http://127.0.0.1:9/dns-query') });
  t.after(async () => {
    await close(echo);
    await close(server);
  });

  const tunnel = await connectTunnel(port, `127.0.0.1:${echoPort}`);
  assert.equal(tunnel.status, 200);
  assert.match(tunnel.head, /Connection Established/i);

  const message = 'ping through the tunnel';
  tunnel.socket.write(message);
  const echoed = await readExactly(tunnel.socket, message.length);
  assert.equal(echoed.toString('utf8'), message);
  tunnel.socket.destroy();
});

test('CONNECT replies 502 for unreachable targets', async (t) => {
  const { server, port } = await startProxy({ resolver: mockResolver('http://127.0.0.1:9/dns-query') });
  t.after(() => close(server));

  const closed = net.createServer();
  const closedPort = await listen(closed);
  await close(closed);

  const tunnel = await connectTunnel(port, `127.0.0.1:${closedPort}`);
  assert.equal(tunnel.status, 502);
  tunnel.socket.destroy();
});

test('proxy requires Proxy-Authorization when --auth is set', async (t) => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  const upstreamPort = await listen(upstream);
  const { server, port } = await startProxy({
    auth: { user: 'me', pass: 's3cret' },
    resolver: mockResolver('http://127.0.0.1:9/dns-query')
  });
  t.after(async () => {
    await close(upstream);
    await close(server);
  });

  const call = (authorization) => new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${upstreamPort}` };
    if (authorization) headers['proxy-authorization'] = authorization;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `http://127.0.0.1:${upstreamPort}/`,
      headers
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(await call(null), 407);
  assert.equal(await call(`Basic ${Buffer.from('me:wrong').toString('base64')}`), 407);
  assert.equal(await call(`Basic ${Buffer.from('me:s3cret').toString('base64')}`), 200);

  const denied = await connectTunnel(port, `127.0.0.1:${upstreamPort}`);
  assert.equal(denied.status, 407);
  denied.socket.destroy();

  const allowed = await connectTunnel(port, `127.0.0.1:${upstreamPort}`, {
    headers: { 'Proxy-Authorization': `Basic ${Buffer.from('me:s3cret').toString('base64')}` }
  });
  assert.equal(allowed.status, 200);
  allowed.socket.destroy();
});
