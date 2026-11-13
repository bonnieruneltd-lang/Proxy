'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { URL } = require('node:url');

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const VERSION = require('../../package.json').version;

function basicCredentials(header) {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header).trim());
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(header, auth) {
  if (!auth) return true;
  const creds = basicCredentials(header);
  if (!creds) return false;
  return safeEqual(creds.user, auth.user) && safeEqual(creds.pass, auth.pass);
}

/**
 * Splits "example.com:443", "[::1]:443" or "example.com" into host + port.
 */
function splitHostPort(authority) {
  const value = String(authority || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { host: value, port: 443 };
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: value.slice(0, idx), port };
}

function unbracket(hostname) {
  return String(hostname).replace(/^\[/, '').replace(/\]$/, '');
}

function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function createHttpProxy({ resolver, auth = null, timeout = 6000, stats, logger }) {
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 32 });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128, maxFreeSockets: 32 });
  const idleTimeout = Math.max(timeout * 5, 30000);

  function challenge(res) {
    const headers = {
      'proxy-authenticate': 'Basic realm="wififree", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '0'
    };
    res.writeHead(407, headers);
    res.end();
  }

  function badGateway(res, message, details) {
    const body = `wififree proxy error\n\n${message}\n`;
    if (!res.headersSent) {
      res.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      });
    }
    res.end(body);
    if (logger && details) logger.debug(details);
  }

  function handleHttp(req, res) {
    if (!checkAuth(req.headers['proxy-authorization'], auth)) {
      challenge(res);
      return;
    }

    let target;
    try {
      target = new URL(req.url);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('wififree: expected an absolute URL (this port is an HTTP proxy)\n');
      return;
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`wififree: unsupported protocol ${target.protocol}\n`);
      return;
    }

    const secure = target.protocol === 'https:';
    const mod = secure ? https : http;
    const headers = filterHeaders(req.headers);
    headers.host = target.host;
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

    const options = {
      protocol: target.protocol,
      hostname: unbracket(target.hostname),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
      agent: secure ? httpsAgent : httpAgent,
      lookup: resolver.lookup
    };
    if (secure && !net.isIP(options.hostname)) {
      options.servername = options.hostname;
    }

    stats.requests += 1;
    stats.recordHost(target.hostname);

    const upstream = mod.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, filterHeaders(upstreamRes.headers));
      upstreamRes.on('data', (chunk) => { stats.bytesDown += chunk.length; });
      upstreamRes.on('end', () => { stats.completed += 1; });
      upstreamRes.pipe(res);
    });

    upstream.setTimeout(idleTimeout, () => {
      upstream.destroy(new Error(`upstream timed out after ${idleTimeout}ms`));
    });

    upstream.on('error', (err) => {
      stats.errors += 1;
      badGateway(res, `${req.method} ${target.href} failed: ${err.message}`, err.stack);
    });

    req.on('data', (chunk) => { stats.bytesUp += chunk.length; });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  function handleConnect(req, clientSocket, head) {
    if (!checkAuth(req.headers['proxy-authorization'], auth)) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n'
        + 'Proxy-Authenticate: Basic realm="wififree", charset="UTF-8"\r\n'
        + 'Content-Length: 0\r\nConnection: close\r\n\r\n'
      );
      return;
    }

    const target = splitHostPort(req.url);
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }

    stats.connections += 1;
    stats.recordHost(target.host);
    let established = false;

    const upstream = net.connect({ host: target.host, port: target.port, lookup: resolver.lookup });
    upstream.setNoDelay(true);
    clientSocket.setNoDelay(true);
    upstream.setTimeout(idleTimeout, () => {
      upstream.destroy(new Error(`tunnel idle for ${idleTimeout}ms`));
    });

    upstream.once('connect', () => {
      established = true;
      clientSocket.write(`HTTP/1.1 200 Connection Established\r\nProxy-Agent: wififree/${VERSION}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.on('data', (chunk) => { stats.bytesDown += chunk.length; });
      clientSocket.on('data', (chunk) => { stats.bytesUp += chunk.length; });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.once('error', (err) => {
      stats.errors += 1;
      logger.debug(`CONNECT ${target.host}:${target.port} failed: ${err.message}`);
      if (!established) {
        established = true;
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else {
        clientSocket.destroy();
      }
    });

    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => {
      stats.connections = Math.max(0, stats.connections - 1);
      upstream.destroy();
    });
  }

  function handleUpgrade(req, socket, head) {
    let target;
    try {
      target = new URL(req.url);
    } catch (err) {
      socket.destroy();
      return;
    }
    if (target.protocol !== 'http:') {
      socket.destroy();
      return;
    }

    stats.requests += 1;
    stats.recordHost(target.hostname);

    const upstream = net.connect({
      host: unbracket(target.hostname),
      port: target.port || 80,
      lookup: resolver.lookup
    });

    upstream.once('connect', () => {
      const headers = filterHeaders(req.headers);
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade || 'websocket';
      headers.host = target.host;
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      stats.errors += 1;
      logger.debug(`upgrade to ${target.href} failed: ${err.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }

  function close() {
    httpAgent.destroy();
    httpsAgent.destroy();
  }

  return { handleHttp, handleConnect, handleUpgrade, close };
}

module.exports = {
  createHttpProxy,
  basicCredentials,
  splitHostPort,
  filterHeaders,
  unbracket,
  HOP_BY_HOP
};
