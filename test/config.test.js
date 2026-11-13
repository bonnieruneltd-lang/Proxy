'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeConfig, parseArgs, usage, DEFAULT_BYPASS } = require('../src/config');

test('parseArgs understands --key value, --key=value, flags and --no-flags', () => {
  const args = parseArgs([
    'serve',
    '--port', '9090',
    '--host=0.0.0.0',
    '--no-socks',
    '--lan',
    '--bypass', 'a.test',
    '--bypass', 'b.test'
  ]);
  assert.deepEqual(args._, ['serve']);
  assert.equal(args.port, '9090');
  assert.equal(args.host, '0.0.0.0');
  assert.equal(args.socks, false);
  assert.equal(args.lan, true);
  assert.deepEqual(args.bypass, ['a.test', 'b.test']);
});

test('normalizeConfig defaults to a loopback-only proxy', () => {
  const config = normalizeConfig([]);
  assert.equal(config.command, 'serve');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8085);
  assert.equal(config.socks, true);
  assert.equal(config.socksHost, '127.0.0.1');
  assert.equal(config.socksPort, 1080);
  assert.equal(config.resolver, 'auto');
  assert.equal(config.ui, true);
  assert.equal(config.auth, null);
  assert.equal(config.timeout, 6000);
  assert.ok(config.bypass.includes('captive.apple.com'));
});

test('--lan binds both listeners to every interface', () => {
  const config = normalizeConfig(['serve', '--lan']);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.socksHost, '0.0.0.0');
  assert.equal(config.lan, true);
});

test('normalizeConfig parses auth, ports, resolver and log level', () => {
  const config = normalizeConfig([
    'serve',
    '--port', '18085',
    '--socks-port', '11080',
    '--auth', 'user:pa:ss',
    '--resolver', 'cloudflare,google',
    '--timeout', '9000',
    '--log-level', 'debug',
    '--no-ui'
  ]);
  assert.equal(config.port, 18085);
  assert.equal(config.socksPort, 11080);
  assert.deepEqual(config.auth, { user: 'user', pass: 'pa:ss' });
  assert.equal(config.resolver, 'cloudflare,google');
  assert.equal(config.timeout, 9000);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.ui, false);
});

test('invalid auth values throw a helpful error', () => {
  assert.throws(() => normalizeConfig(['serve', '--auth', 'nopassword']), /user:password/);
});

test('invalid ports fall back to defaults instead of crashing', () => {
  const config = normalizeConfig(['serve', '--port', '99999', '--socks-port', 'abc']);
  assert.equal(config.port, 8085);
  assert.equal(config.socksPort, 1080);
});

test('extra --bypass entries are appended to the built-in list', () => {
  const config = normalizeConfig(['serve', '--bypass', 'intranet.test,extra.test']);
  for (const builtin of DEFAULT_BYPASS) assert.ok(config.bypass.includes(builtin));
  assert.ok(config.bypass.includes('intranet.test'));
  assert.ok(config.bypass.includes('extra.test'));
});

test('commands are inferred from the first positional argument', () => {
  assert.equal(normalizeConfig(['bench']).command, 'bench');
  assert.equal(normalizeConfig(['pac']).command, 'pac');
  assert.equal(normalizeConfig(['check']).command, 'check');
  assert.equal(normalizeConfig(['--help']).command, 'help');
});

test('usage documents every command and the key flags', () => {
  const text = usage();
  for (const command of ['serve', 'bench', 'pac', 'check']) {
    assert.ok(text.includes(`wififree ${command}`));
  }
  for (const flag of ['--lan', '--auth', '--resolver', '--socks-port', '--no-ui']) {
    assert.ok(text.includes(flag));
  }
});
