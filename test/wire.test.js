'use strict';

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeName,
  encodeQuery,
  decodeName,
  decodeResponse,
  parseWireAnswer,
  formatIPv6
} = require('../src/dns/wire');
const { DohResolver } = require('../src/dns/doh');
const { listen, close, startMockDoh } = require('./helpers');

function ipv6ToBuffer(address) {
  const buffer = Buffer.alloc(16);
  address.split(':').forEach((group, index) => {
    buffer.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  });
  return buffer;
}

function buildAnswer({ name = 'example.com', type = 1, ttl = 60, data, compress = false }) {
  const nameBuffer = compress ? Buffer.from([0xc0, 0x0c]) : encodeName(name);
  let rdata;
  if (type === 1) rdata = Buffer.from(data.split('.').map(Number));
  else if (type === 28) rdata = ipv6ToBuffer(data);
  else rdata = encodeName(data);

  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuffer, fixed, rdata]);
}

function buildResponse({ qname = 'example.com', qtype = 1, answers = [], rcode = 0, flags = 0x8180 }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(flags | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(qtype, 0);
  question.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(qname), question, ...answers]);
}

function startMockWireDoh({ answers, ttl = 60, rcode = 0 } = {}) {
  const state = { requests: 0, queries: [] };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const url = new URL(req.url, 'http://localhost');
    const dns = url.searchParams.get('dns');
    if (url.pathname !== '/dns-query' || !dns) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('wire format only');
      return;
    }
    const query = Buffer.from(dns, 'base64url');
    const [name] = decodeName(query, 12);
    const qtype = query.readUInt16BE(12 + encodeName(name).length);
    state.queries.push({ name, qtype, accept: req.headers.accept });

    const body = buildResponse({
      qname: name,
      qtype,
      rcode,
      answers: answers === undefined
        ? [buildAnswer({ name, type: 1, ttl, data: '93.184.216.34', compress: true })]
        : answers
    });
    res.writeHead(200, {
      'content-type': 'application/dns-message',
      'content-length': body.length
    });
    res.end(body);
  });
  return { server, state };
}

test('encodeQuery produces a valid RFC 1035 question', () => {
  const a = encodeQuery('example.com', 'A');
  assert.equal(
    a.toString('hex'),
    '000001000001000000000000076578616d706c6503636f6d0000010001'
  );
  const aaaa = encodeQuery('example.com', 'AAAA');
  assert.equal(aaaa.readUInt16BE(aaaa.length - 4), 28);
  assert.equal(encodeQuery('example.com', 'A').readUInt16BE(2), 0x0100, 'recursion desired');
});

test('decodeName follows compression pointers', () => {
  const buffer = Buffer.concat([
    Buffer.alloc(12),
    encodeName('example.com'),
    Buffer.from([0xc0, 0x0c])
  ]);
  const [firstName, firstEnd] = decodeName(buffer, 12);
  assert.equal(firstName, 'example.com');
  assert.equal(firstEnd, 25);

  const [pointed, pointedEnd] = decodeName(buffer, 25);
  assert.equal(pointed, 'example.com');
  assert.equal(pointedEnd, 27);
});

test('parseWireAnswer normalises A/AAAA records and TTLs', () => {
  const response = buildResponse({
    answers: [
      buildAnswer({ type: 28, ttl: 30, data: '2606:2800:220:1:248:1893:25c8:1946' }),
      buildAnswer({ type: 1, ttl: 300, data: '93.184.216.34' }),
      buildAnswer({ type: 1, ttl: 120, data: '93.184.216.34' }),
      buildAnswer({ type: 5, ttl: 30, data: 'alias.example.com' })
    ]
  });
  const parsed = decodeResponse(response);
  assert.equal(parsed.rcode, 0);
  assert.equal(parsed.answers.length, 4);
  assert.equal(parsed.answers[3].data, 'alias.example.com');

  const result = parseWireAnswer(response);
  assert.deepEqual(result.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
  assert.equal(result.ttl, 30);
  assert.equal(result.status, 0);
});

test('parseWireAnswer reports NXDOMAIN, errors and truncation', () => {
  const nxdomain = parseWireAnswer(buildResponse({ answers: [], rcode: 3 }));
  assert.equal(nxdomain.status, 3);
  assert.deepEqual(nxdomain.addresses, []);

  assert.throws(() => parseWireAnswer(buildResponse({ answers: [], rcode: 2 })), /status 2/);
  assert.throws(
    () => parseWireAnswer(buildResponse({ answers: [], flags: 0x8180 | 0x0200 })),
    /truncated/
  );
  assert.throws(() => parseWireAnswer(Buffer.from([1, 2, 3])), /short DNS response/);
});

test('formatIPv6 renders full groups', () => {
  assert.equal(
    formatIPv6(ipv6ToBuffer('2606:2800:0220:0001:0248:1893:25c8:1946')),
    '2606:2800:220:1:248:1893:25c8:1946'
  );
});

test('DohResolver speaks the RFC 8484 wire format', async (t) => {
  const { server, state } = startMockWireDoh({});
  const port = await listen(server);
  t.after(() => close(server));

  const resolver = new DohResolver({
    id: 'wire',
    endpoint: `http://127.0.0.1:${port}/dns-query`,
    timeout: 2000,
    format: 'wire'
  });

  const result = await resolver.query('example.com', 'A');
  assert.deepEqual(result.addresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(state.requests, 1);
  assert.equal(state.queries[0].name, 'example.com');
  assert.equal(state.queries[0].qtype, 1);
  assert.equal(state.queries[0].accept, 'application/dns-message');
  resolver.close();
});

test('auto format detects wire-only and JSON-only endpoints', async (t) => {
  const wire = startMockWireDoh({});
  const wirePort = await listen(wire.server);
  const json = startMockDoh({});
  const jsonPort = await listen(json.server);
  t.after(async () => {
    await close(wire.server);
    await close(json.server);
  });

  const wireResolver = new DohResolver({
    id: 'auto-wire',
    endpoint: `http://127.0.0.1:${wirePort}/dns-query`,
    timeout: 2000,
    format: 'auto'
  });
  const wireResult = await wireResolver.query('example.com', 'A');
  assert.deepEqual(wireResult.addresses.map((a) => a.address), ['93.184.216.34']);
  assert.equal(wireResolver.workingFormat, 'wire');
  wireResolver.close();

  const jsonResolver = new DohResolver({
    id: 'auto-json',
    endpoint: `http://127.0.0.1:${jsonPort}/dns-query`,
    timeout: 2000,
    format: 'auto'
  });
  const jsonResult = await jsonResolver.query('example.com', 'A');
  assert.deepEqual(jsonResult.addresses.map((a) => a.address), ['93.184.216.34']);
  assert.equal(jsonResolver.workingFormat, 'json', 'falls back when wire is not supported');
  jsonResolver.close();
});
