'use strict';

const http = require('node:http');
const { DohResolver } = require('../src/dns/doh');
const { Resolver } = require('../src/dns/resolver');

const ZONE = {
  'example.com': {
    A: ['93.184.216.34'],
    AAAA: ['2606:2800:220:1:248:1893:25c8:1946']
  },
  'site.test': { A: ['127.0.0.1'] },
  'dual.test': { A: ['127.0.0.1'], AAAA: ['::1'] }
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

/**
 * A tiny DNS-over-HTTPS JSON endpoint (RFC 8484 /dns-query?name=..&type=..).
 */
function startMockDoh({ zone = ZONE, delay = 0, fail = false } = {}) {
  const state = { requests: 0, names: [], delays: [] };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/dns-query') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (fail) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    const name = String(url.searchParams.get('name') || '').toLowerCase();
    const type = String(url.searchParams.get('type') || 'A').toUpperCase();
    state.names.push(`${type}:${name}`);
    state.delays.push(delay);

    const send = () => {
      const record = zone[name];
      let payload;
      if (!record) {
        payload = { Status: 3, Question: [{ name, type }] };
      } else {
        const values = type === 'AAAA' ? record.AAAA : record.A;
        payload = {
          Status: 0,
          Question: [{ name, type }],
          Answer: (values || []).map((address) => ({
            name,
            type: type === 'AAAA' ? 28 : 1,
            TTL: 60,
            data: address
          }))
        };
      }
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, {
        'content-type': 'application/dns-json',
        'content-length': body.length
      });
      res.end(body);
    };

    if (delay) setTimeout(send, delay);
    else send();
  });
  return { server, state };
}

function mockResolver(endpoint, { extra = [], timeout = 1500 } = {}) {
  const resolvers = [
    new DohResolver({ id: 'mock', label: 'Mock DoH', endpoint, bootstrap: '127.0.0.1', timeout, format: 'json' }),
    ...extra
  ];
  return new Resolver({ resolvers, label: 'mock' });
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false,
      timeout: options.timeout || 5000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.setTimeout(options.timeout || 5000, () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    if (options.body) req.end(options.body);
    else req.end();
  });
}

/**
 * Opens a raw TCP connection to the CONNECT proxy and returns the socket
 * after the "200 Connection Established" line.
 */
function connectTunnel(port, authority, { headers = {} } = {}) {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const head = buffer.slice(0, end);
      const rest = Buffer.from(buffer.slice(end + 4), 'latin1');
      const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1] || 0);
      resolve({ socket, status, head, rest });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('connect', () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, 'Host: ' + authority];
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  });
}

function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

module.exports = {
  ZONE,
  listen,
  close,
  startMockDoh,
  mockResolver,
  request,
  connectTunnel,
  waitFor
};
