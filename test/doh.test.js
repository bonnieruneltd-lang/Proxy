'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDohAnswer, DohResolver, DnsError } = require('../src/dns/doh');
const { Resolver, SystemResolver, createResolver } = require('../src/dns/resolver');
const { listen, close, startMockDoh, mockResolver, waitFor } = require('./helpers');

test('parseDohAnswer keeps IPv4 first, de-dupes and clamps TTL', () => {
  const result = parseDohAnswer({
    Status: 0,
    Answer: [
      { type: 28, TTL: 30, data: '2606:2800:220:1:248:1893:25c8:1946' },
      { type: 1, TTL: 9999, data: '93.184.216.34' },
      { type: 1, TTL: 60, data: '93.184.216.34' },
      { type: 5, TTL: 60, data: 'example.com.' }
    ]
  });
  assert.deepEqual(result.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
  assert.equal(result.ttl, 30, 'lowest record TTL wins');
  assert.equal(result.status, 0);
});

test('parseDohAnswer clamps tiny TTLs and reports NXDOMAIN', () => {
  const low = parseDohAnswer({ Status: 0, Answer: [{ type: 1, TTL: 1, data: '1.2.3.4' }] });
  assert.equal(low.ttl, 5);

  const missing = parseDohAnswer({ Status: 3, Question: [{ name: 'nope.test' }] });
  assert.deepEqual(missing.addresses, []);
  assert.equal(missing.status, 3);
});

test('parseDohAnswer rejects garbage', () => {
  assert.throws(() => parseDohAnswer(null), DnsError);
  assert.throws(() => parseDohAnswer({ nope: true }), DnsError);
  assert.throws(() => parseDohAnswer({ Status: 2 }), /status 2/);
});

test('DohResolver caches answers and de-dupes in-flight queries', async (t) => {
  const { server, state } = startMockDoh({ delay: 25 });
  const port = await listen(server);
  t.after(() => close(server));

  const resolver = new DohResolver({
    id: 'mock',
    endpoint: `http://127.0.0.1:${port}/dns-query`,
    timeout: 2000, format: 'json'
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => resolver.query('example.com', 'A'))
  );
  assert.equal(state.requests, 1, 'concurrent lookups should share one request');
  for (const result of results) {
    assert.deepEqual(result.addresses.map((a) => a.address), ['93.184.216.34']);
  }

  await resolver.query('example.com', 'A');
  assert.equal(state.requests, 1, 'second lookup should be served from cache');
  assert.equal(resolver.stats.hits, 1);
  assert.equal(resolver.stats.queries, 1);

  await resolver.query('example.com', 'AAAA');
  assert.equal(state.requests, 2, 'AAAA is cached separately');
  resolver.close();
});

test('DohResolver surfaces HTTP errors and counts failures', async (t) => {
  const { server } = startMockDoh({ fail: true });
  const port = await listen(server);
  t.after(() => close(server));

  const resolver = new DohResolver({
    id: 'broken',
    endpoint: `http://127.0.0.1:${port}/dns-query`,
    timeout: 1000, format: 'json'
  });
  await assert.rejects(() => resolver.query('example.com', 'A'), (err) => {
    assert.equal(err.code, 'EHTTP');
    return true;
  });
  assert.equal(resolver.stats.errors, 1);
  assert.equal(resolver.stats.consecutiveFailures, 1);
  resolver.close();
});

test('Resolver races resolvers and keeps the winner', async (t) => {
  const fast = startMockDoh({ delay: 5 });
  const slow = startMockDoh({ delay: 120 });
  const fastPort = await listen(fast.server);
  const slowPort = await listen(slow.server);
  t.after(async () => {
    await close(fast.server);
    await close(slow.server);
  });

  const resolver = new Resolver({
    resolvers: [
      new DohResolver({ id: 'slow', label: 'Slow DoH', endpoint: `http://127.0.0.1:${slowPort}/dns-query`, timeout: 2000, format: 'json' }),
      new DohResolver({ id: 'fast', label: 'Fast DoH', endpoint: `http://127.0.0.1:${fastPort}/dns-query`, timeout: 2000, format: 'json' })
    ]
  });

  const result = await resolver.query('site.test', 'A');
  assert.deepEqual(result.addresses.map((a) => a.address), ['127.0.0.1']);
  assert.equal(resolver.lastWinner, 'fast');

  // Give the slower resolver time to finish and record its sample.
  const slowStats = await waitFor(() => {
    const found = resolver.stats().resolvers.find((r) => r.id === 'slow');
    return found && found.latencyMs != null ? found : null;
  });
  const fastStats = resolver.stats().resolvers.find((r) => r.id === 'fast');
  assert.ok(fastStats.latencyMs < slowStats.latencyMs, 'fast resolver must measure lower');
  resolver.close();
});

test('Resolver fails over to a healthy resolver', async (t) => {
  const broken = startMockDoh({ fail: true });
  const good = startMockDoh({});
  const brokenPort = await listen(broken.server);
  const goodPort = await listen(good.server);
  t.after(async () => {
    await close(broken.server);
    await close(good.server);
  });

  const resolver = new Resolver({
    resolvers: [
      new DohResolver({ id: 'broken', endpoint: `http://127.0.0.1:${brokenPort}/dns-query`, timeout: 1000, format: 'json' }),
      new DohResolver({ id: 'good', endpoint: `http://127.0.0.1:${goodPort}/dns-query`, timeout: 1000, format: 'json' })
    ]
  });

  const result = await resolver.query('site.test', 'A');
  assert.deepEqual(result.addresses.map((a) => a.address), ['127.0.0.1']);
  assert.equal(resolver.lastWinner, 'good');
  assert.equal(resolver.degraded, false);
  resolver.close();
});

test('Resolver lookup returns all records, IPv4 first', async (t) => {
  const { server } = startMockDoh({});
  const port = await listen(server);
  t.after(() => close(server));

  const resolver = mockResolver(`http://127.0.0.1:${port}/dns-query`);

  const all = await new Promise((resolve, reject) => {
    resolver.lookup('dual.test', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
  assert.deepEqual(all, [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 }
  ]);

  const single = await new Promise((resolve, reject) => {
    resolver.lookup('dual.test', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
  assert.deepEqual(single, { address: '127.0.0.1', family: 4 });

  const literal = await new Promise((resolve, reject) => {
    resolver.lookup('10.1.2.3', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
  assert.deepEqual(literal, [{ address: '10.1.2.3', family: 4 }]);
  resolver.close();
});

test('Resolver lookup reports ENOTFOUND for missing names', async (t) => {
  const { server } = startMockDoh({});
  const port = await listen(server);
  t.after(() => close(server));

  const resolver = mockResolver(`http://127.0.0.1:${port}/dns-query`);
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      resolver.lookup('missing.test', {}, (err, address) => (err ? reject(err) : resolve(address)));
    }),
    (err) => {
      assert.equal(err.code, 'ENOTFOUND');
      return true;
    }
  );
  resolver.close();
});

test('Resolver falls back to system DNS when every DoH resolver fails', async (t) => {
  const broken = startMockDoh({ fail: true });
  const port = await listen(broken.server);
  t.after(() => close(broken.server));

  const resolver = new Resolver({
    resolvers: [
      new DohResolver({ id: 'broken', endpoint: `http://127.0.0.1:${port}/dns-query`, timeout: 800, format: 'json' }),
      new SystemResolver()
    ]
  });

  const result = await resolver.query('localhost', 'A');
  assert.ok(result.addresses.some((a) => a.address === '127.0.0.1' || a.address === '::1'));
  assert.equal(resolver.degraded, true);
  resolver.close();
});

test('createResolver understands presets, custom URLs and rejects typos', () => {
  const auto = createResolver('auto');
  assert.ok(auto.dohResolvers.length >= 3);
  assert.equal(auto.systemResolvers.length, 1);
  auto.close();

  const onlyGoogle = createResolver('google', { includeSystem: false });
  assert.deepEqual(onlyGoogle.enabled.map((r) => r.id), ['google']);
  onlyGoogle.close();

  const custom = createResolver('https://dns.example/dns-query', { includeSystem: false });
  assert.equal(custom.enabled[0].type, 'doh');
  custom.close();

  assert.throws(() => createResolver('cloudflar'), /unknown resolver/);
});

test('bench ranks resolvers fastest first and marks a winner', async (t) => {
  const fast = startMockDoh({ delay: 1 });
  const slow = startMockDoh({ delay: 60 });
  const fastPort = await listen(fast.server);
  const slowPort = await listen(slow.server);
  t.after(async () => {
    await close(fast.server);
    await close(slow.server);
  });

  const resolver = new Resolver({
    resolvers: [
      new DohResolver({ id: 'slow', label: 'Slow', endpoint: `http://127.0.0.1:${slowPort}/dns-query`, timeout: 2000, format: 'json' }),
      new DohResolver({ id: 'fast', label: 'Fast', endpoint: `http://127.0.0.1:${fastPort}/dns-query`, timeout: 2000, format: 'json' })
    ]
  });

  const result = await resolver.bench({ host: 'example.com', rounds: 3 });
  assert.equal(result.fastest, 'fast');
  assert.deepEqual(result.results.map((r) => r.id), ['fast', 'slow']);
  assert.ok(result.results[0].medianMs < result.results[1].medianMs);
  resolver.close();
});
