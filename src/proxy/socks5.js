'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const REP = {
  SUCCESS: 0x00,
  GENERAL: 0x01,
  NOT_ALLOWED: 0x02,
  NET_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  CMD_UNSUPPORTED: 0x07,
  ATYP_UNSUPPORTED: 0x08
};

function replyCodeFor(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED': return REP.REFUSED;
    case 'ENETUNREACH': return REP.NET_UNREACHABLE;
    case 'EHOSTUNREACH': return REP.HOST_UNREACHABLE;
    case 'ETIMEDOUT': return REP.TTL_EXPIRED;
    case 'EACCES':
    case 'EPERM': return REP.NOT_ALLOWED;
    default: return REP.GENERAL;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function formatIPv6(buffer) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
  return groups.join(':');
}

class SocksSession {
  constructor(socket, options) {
    this.socket = socket;
    this.options = options;
    this.state = 'greeting';
    this.buffer = Buffer.alloc(0);
    this.upstream = null;
    this.request = null;

    socket.setNoDelay(true);
    socket.setTimeout(options.idleTimeout, () => this.destroy());
    this.onData = (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      try {
        this.step();
      } catch (err) {
        options.logger.debug(`SOCKS5 session error: ${err.message}`);
        this.destroy();
      }
    };
    socket.on('data', this.onData);
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.closeUpstream());
  }

  step() {
    if (this.state === 'greeting') this.readGreeting();
    else if (this.state === 'auth') this.readAuth();
    else if (this.state === 'request') this.readRequest();
  }

  readGreeting() {
    if (this.buffer.length < 2) return;
    if (this.buffer[0] !== 0x05) {
      this.destroy();
      return;
    }
    const count = this.buffer[1];
    if (this.buffer.length < 2 + count) return;
    const methods = this.buffer.subarray(2, 2 + count);
    this.buffer = this.buffer.subarray(2 + count);

    const needsAuth = Boolean(this.options.auth);
    const method = needsAuth ? 0x02 : 0x00;
    if (!methods.includes(method)) {
      this.socket.end(Buffer.from([0x05, 0xff]));
      return;
    }
    this.socket.write(Buffer.from([0x05, method]));
    this.state = needsAuth ? 'auth' : 'request';
    this.step();
  }

  readAuth() {
    if (this.buffer.length < 2) return;
    if (this.buffer[0] !== 0x01) {
      this.socket.end(Buffer.from([0x01, 0x01]));
      return;
    }
    const userLen = this.buffer[1];
    if (this.buffer.length < 2 + userLen + 1) return;
    const passLen = this.buffer[2 + userLen];
    if (this.buffer.length < 3 + userLen + passLen) return;

    const user = this.buffer.subarray(2, 2 + userLen).toString('utf8');
    const pass = this.buffer.subarray(3 + userLen, 3 + userLen + passLen).toString('utf8');
    this.buffer = this.buffer.subarray(3 + userLen + passLen);

    const { auth, stats } = this.options;
    const ok = safeEqual(user, auth.user) && safeEqual(pass, auth.pass);
    if (!ok) {
      stats.authFailures += 1;
      this.socket.end(Buffer.from([0x01, 0x01]));
      return;
    }
    this.socket.write(Buffer.from([0x01, 0x00]));
    this.state = 'request';
    this.step();
  }

  readRequest() {
    if (this.buffer.length < 4) return;
    const ver = this.buffer[0];
    const cmd = this.buffer[1];
    const atyp = this.buffer[3];
    if (ver !== 0x05) {
      this.destroy();
      return;
    }

    let offset = 4;
    let host = null;
    if (atyp === 0x01) {
      if (this.buffer.length < offset + 4 + 2) return;
      host = `${this.buffer[offset]}.${this.buffer[offset + 1]}.${this.buffer[offset + 2]}.${this.buffer[offset + 3]}`;
      offset += 4;
    } else if (atyp === 0x04) {
      if (this.buffer.length < offset + 16 + 2) return;
      host = formatIPv6(this.buffer.subarray(offset, offset + 16));
      offset += 16;
    } else if (atyp === 0x03) {
      if (this.buffer.length < offset + 1) return;
      const len = this.buffer[offset];
      if (this.buffer.length < offset + 1 + len + 2) return;
      host = this.buffer.subarray(offset + 1, offset + 1 + len).toString('utf8');
      offset += 1 + len;
    } else {
      this.reply(REP.ATYP_UNSUPPORTED);
      return;
    }

    const port = this.buffer.readUInt16BE(offset);
    offset += 2;
    this.buffer = this.buffer.subarray(offset);
    this.request = { cmd, host, port };

    if (cmd !== 0x01) {
      // BIND (0x02) and UDP ASSOCIATE (0x03) are intentionally not supported.
      this.reply(REP.CMD_UNSUPPORTED);
      return;
    }
    this.connect();
  }

  connect() {
    const { host, port } = this.request;
    const { stats, resolver, logger, idleTimeout } = this.options;
    logger.debug(`SOCKS5 CONNECT ${host}:${port}`);
    stats.connections += 1;
    stats.recordHost(host);
    this.socket.setTimeout(0);

    const upstream = net.connect({ host, port, lookup: resolver.lookup });
    this.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.setTimeout(idleTimeout, () => upstream.destroy(new Error('idle')));

    upstream.once('connect', () => {
      this.reply(REP.SUCCESS);
      this.state = 'relay';
      stats.tunnels += 1;
      this.socket.removeListener('data', this.onData);
      if (this.buffer.length) {
        upstream.write(this.buffer);
        this.buffer = Buffer.alloc(0);
      }
      upstream.on('data', (chunk) => { stats.bytesDown += chunk.length; });
      this.socket.on('data', (chunk) => { stats.bytesUp += chunk.length; });
      upstream.pipe(this.socket);
      this.socket.pipe(upstream);
    });

    upstream.once('error', (err) => {
      stats.errors += 1;
      logger.debug(`SOCKS5 ${host}:${port} failed: ${err.message}`);
      if (this.state === 'relay') this.destroy();
      else this.reply(replyCodeFor(err));
    });
  }

  reply(rep) {
    if (rep !== REP.SUCCESS) this.options.stats.errors += 1;
    this.socket.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    if (rep !== REP.SUCCESS) this.socket.end();
  }

  closeUpstream() {
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
  }

  destroy() {
    this.closeUpstream();
    this.socket.destroy();
  }
}

function createSocks5Server({ resolver, auth = null, stats, logger, idleTimeout = 60000 }) {
  if (auth && (String(auth.user).length > 255 || String(auth.pass).length > 255)) {
    throw new Error('SOCKS5 credentials must be <= 255 bytes each');
  }
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    new SocksSession(socket, { resolver, auth, stats, logger, idleTimeout });
  });
  // Mirrors http.Server.closeAllConnections so shutdown never waits on a tunnel.
  server.closeAllConnections = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return server;
}

module.exports = { createSocks5Server, replyCodeFor, formatIPv6, REP };
