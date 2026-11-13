'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generatePac, matchesPattern, shouldBypass } = require('../src/pac');
const { DEFAULT_BYPASS } = require('../src/config');

test('matchesPattern supports wildcards', () => {
  assert.ok(matchesPattern('foo.local', '*.local'));
  assert.equal(matchesPattern('local', '*.local'), false, 'shExpMatch needs a dot');
  assert.ok(matchesPattern('api.example.com', '*.example.com'));
  assert.ok(matchesPattern('172.20.5.5', '172.2?.*'));
  assert.ok(!matchesPattern('172.30.5.5', '172.2?.*'));
  assert.ok(matchesPattern('192.168.1.9', '192.168.*'));
  assert.ok(!matchesPattern('example.com', '*.local'));
});

test('shouldBypass keeps local and captive-portal traffic direct', () => {
  assert.ok(shouldBypass('localhost'));
  assert.ok(shouldBypass('127.0.0.1'));
  assert.ok(shouldBypass('::1'));
  assert.ok(shouldBypass('printer')); // plain hostname = intranet
  assert.ok(shouldBypass('192.168.1.1', DEFAULT_BYPASS));
  assert.ok(shouldBypass('connectivitycheck.gstatic.com', DEFAULT_BYPASS));
  assert.ok(shouldBypass('captive.apple.com', DEFAULT_BYPASS));
  assert.ok(!shouldBypass('example.com', DEFAULT_BYPASS));
  assert.ok(!shouldBypass('blocked-site.example', DEFAULT_BYPASS));
});

test('generatePac produces a valid, escaped PAC script', () => {
  const pac = generatePac({
    host: '192.168.1.20',
    port: 8085,
    bypass: ['*.example', '10.*'],
    proxyName: 'wififree'
  });

  assert.ok(pac.startsWith('// wififree PAC script'));
  assert.ok(pac.includes('function FindProxyForURL(url, host)'));
  assert.ok(pac.includes('return "PROXY 192.168.1.20:8085; DIRECT";'));
  assert.ok(pac.includes('"*.example"'));
  assert.ok(pac.includes('"10.*"'));
  assert.ok(pac.includes('isPlainHostName(host)'));
  assert.ok(pac.includes('/^192\\.168\\./'));

  // The generated script must be syntactically valid JavaScript.
  assert.doesNotThrow(() => new Function('isPlainHostName', 'shExpMatch', pac));
});

test('generatePac supports SOCKS5 and fail-closed mode', () => {
  const pac = generatePac({ host: '10.0.0.5', port: 1080, type: 'socks5', failOpen: false, bypass: [] });
  assert.ok(pac.includes('return "SOCKS5 10.0.0.5:1080";'));
  assert.ok(!pac.includes('SOCKS5 10.0.0.5:1080; DIRECT'));
});

test('generatePac omits empty bypass entries', () => {
  const pac = generatePac({ host: '127.0.0.1', port: 8085, bypass: ['', '  ', null, undefined] });
  const match = pac.match(/var BYPASS = \[([\s\S]*?)\];/);
  assert.ok(match);
  assert.equal(match[1].trim(), '');
});
