'use strict';

const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSocks5Server, replyCodeFor, formatIPv6, REP } = require('../src/proxy/socks5');
const { createStats } = require('../src/server');
const { createLogger } = require('../src/log');
const { listen, close, mockResolver, startMockDoh } = require('./helpers');

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
  });
}

function echoServer() {
  return net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
}

async function startSocks({ auth = null } = {}) {
  const server = createSocks5Server({
    auth,
    resolver: mockResolver('http://127.0.0.1:9/dns-query'),
    stats: createStats(),
    logger,
    idleTimeout: 5000
  });
  const port = await listen(server);
  return { server, port };
}

function requestBytes({ cmd = 0x01, atyp = 0x01, host = '127.0.0.1', port = 80 } = {}) {
  const parts = [0x05, cmd, 0x00];
  if (atyp === 0x03) {
    const bytes = Buffer.from(host, 'utf8');
    parts.push(0x03, bytes.length, ...bytes);
  } else if (atyp === 0x01) {
    parts.push(0x01, ...host.split('.').map(Number));
  } else {
    parts.push(0x04);
  }
  parts.push((port >> 8) & 0xff, port & 0xff);
  return Buffer.from(parts);
}

async function connect(port) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('replyCodeFor maps socket errors to SOCKS5 reply codes', () => {
  assert.equal(replyCodeFor({ code: 'ECONNREFUSED' }), REP.REFUSED);
  assert.equal(replyCodeFor({ code: 'ENETUNREACH' }), REP.NET_UNREACHABLE);
  assert.equal(replyCodeFor({ code: 'EHOSTUNREACH' }), REP.HOST_UNREACHABLE);
  assert.equal(replyCodeFor({ code: 'ETIMEDOUT' }), REP.TTL_EXPIRED);
  assert.equal(replyCodeFor({ code: 'EACCES' }), REP.NOT_ALLOWED);
  assert.equal(replyCodeFor({ code: 'EWHATEVER' }), REP.GENERAL);
  assert.equal(replyCodeFor(null), REP.GENERAL);
});

test('formatIPv6 renders RFC style groups', () => {
  const buffer = Buffer.from([
    0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0x01
  ]);
  assert.equal(formatIPv6(buffer), '2001:db8:0:0:0:0:0:1');
});

test('SOCKS5 CONNECT relays data for IPv4 targets', async (t) => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const { server, port } = await startSocks();
  t.after(async () => {
    await close(echo);
    await close(server);
  });

  const socket = await connect(port);
  t.after(() => socket.destroy());

  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual([...(await readExactly(socket, 2))], [0x05, 0x00]);

  socket.write(requestBytes({ atyp: 0x01, host: '127.0.0.1', port: echoPort }));
  const reply = await readExactly(socket, 10);
  assert.equal(reply[0], 0x05);
  assert.equal(reply[1], REP.SUCCESS);

  const message = 'socks5 relay works';
  socket.write(Buffer.from(message));
  assert.equal((await readExactly(socket, message.length)).toString('utf8'), message);
  socket.destroy();
});

test('SOCKS5 CONNECT resolves domain names through the DoH resolver', async (t) => {
  const echo = echoServer();
  const echoPort = await listen(echo);

  const { server: dohServer } = startMockDoh({ zone: { 'local.test': { A: ['127.0.0.1'] } } });
  const dohPort = await listen(dohServer);

  const server = createSocks5Server({
    resolver: mockResolver(`http://127.0.0.1:${dohPort}/dns-query`),
    stats: createStats(),
    logger,
    idleTimeout: 5000
  });
  const port = await listen(server);
  t.after(async () => {
    await close(echo);
    await close(server);
    await close(dohServer);
  });

  const socket = await connect(port);
  t.after(() => socket.destroy());
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(socket, 2);

  socket.write(requestBytes({ atyp: 0x03, host: 'local.test', port: echoPort }));
  const reply = await readExactly(socket, 10);
  assert.equal(reply[1], REP.SUCCESS, 'domain name should resolve via DoH');

  const message = 'domain relay';
  socket.write(Buffer.from(message));
  assert.equal((await readExactly(socket, message.length)).toString('utf8'), message);
  socket.destroy();
});

test('SOCKS5 maps refused connections and rejects unsupported commands', async (t) => {
  const { server, port } = await startSocks();
  t.after(() => close(server));

  const closed = net.createServer();
  const closedPort = await listen(closed);
  await close(closed);

  const socket = await connect(port);
  t.after(() => socket.destroy());
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(socket, 2);
  socket.write(requestBytes({ atyp: 0x01, host: '127.0.0.1', port: closedPort }));
  const refused = await readExactly(socket, 10);
  assert.equal(refused[1], REP.REFUSED);

  const second = await connect(port);
  t.after(() => second.destroy());
  second.write(Buffer.from([0x05, 0x01, 0x00]));
  await readExactly(second, 2);
  second.write(requestBytes({ cmd: 0x03, atyp: 0x01, host: '127.0.0.1', port: 9 }));
  const unsupported = await readExactly(second, 10);
  assert.equal(unsupported[1], REP.CMD_UNSUPPORTED);
});

test('SOCKS5 username/password auth accepts valid and rejects invalid credentials', async (t) => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const { server, port } = await startSocks({ auth: { user: 'me', pass: 's3cret' } });
  t.after(async () => {
    await close(echo);
    await close(server);
  });

  const denied = await connect(port);
  t.after(() => denied.destroy());
  denied.write(Buffer.from([0x05, 0x01, 0x00]));
  assert.deepEqual([...(await readExactly(denied, 2))], [0x05, 0xff]);

  const socket = await connect(port);
  t.after(() => socket.destroy());
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual([...(await readExactly(socket, 2))], [0x05, 0x02]);

  const user = Buffer.from('me');
  const pass = Buffer.from('s3cret');
  socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
  assert.deepEqual([...(await readExactly(socket, 2))], [0x01, 0x00]);

  socket.write(requestBytes({ port: echoPort }));
  assert.equal((await readExactly(socket, 10))[1], REP.SUCCESS);

  const bad = await connect(port);
  t.after(() => bad.destroy());
  bad.write(Buffer.from([0x05, 0x01, 0x02]));
  await readExactly(bad, 2);
  bad.write(Buffer.concat([
    Buffer.from([0x01, 1]), Buffer.from('m'),
    Buffer.from([4]), Buffer.from('nope')
  ]));
  assert.deepEqual([...(await readExactly(bad, 2))], [0x01, 0x01]);
  denied.destroy();
  socket.destroy();
  bad.destroy();
});
