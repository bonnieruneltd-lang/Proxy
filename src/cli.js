'use strict';

const http = require('node:http');
const tls = require('node:tls');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { normalizeConfig, usage, VERSION, NAME } = require('./config');
const { createLogger } = require('./log');
const { createResolver } = require('./dns/resolver');
const { generatePac } = require('./pac');
const { createApp } = require('./server');

const out = (text = '') => process.stdout.write(`${text}\n`);

function ms(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}ms`;
}

function pad(value, length) {
  const text = String(value);
  return text.length >= length ? text : text + ' '.repeat(length - text.length);
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  execFile(command[0], command[1], () => {});
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function tcpTlsCheck(host, port, lookup, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = tls.connect({ host, port, lookup, servername: host, ALPNProtocols: ['h2', 'http/1.1'] });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeout, () => fail(new Error(`TLS handshake to ${host}:${port} timed out`)));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const elapsed = performance.now() - started;
      const info = {
        ms: elapsed,
        address: socket.remoteAddress,
        protocol: socket.getProtocol(),
        alpn: socket.alpnProtocol,
        authorized: socket.authorized,
        subject: socket.getPeerCertificate() ? socket.getPeerCertificate().subject.CN : null
      };
      socket.end();
      resolve(info);
    });
  });
}

function banner(config, address) {
  const hostForDisplay = config.host === '0.0.0.0' ? config.lanAddress : '127.0.0.1';
  const port = address.port;
  const lines = [
    '',
    `  ${NAME} ${VERSION} - proxy + fast browser for restrictive Wi-Fi`,
    '',
    `  Browser UI     http://${hostForDisplay}:${port}/`,
    `  HTTP proxy     ${hostForDisplay}:${port}`,
    address.socksPort ? `  SOCKS5 proxy   socks5://${hostForDisplay}:${address.socksPort}` : null,
    `  PAC file       http://${hostForDisplay}:${port}/proxy.pac`,
    `  DNS            ${config.resolver} (DNS-over-HTTPS, fastest resolver wins)`,
    config.auth ? `  Auth           required (${config.auth.user})` : '  Auth           open - add --auth user:pass before sharing',
    '',
    '  Point your browser at the proxy or PAC file above, or just use the',
    '  built-in browser. Press Ctrl+C to stop.',
    ''
  ].filter(Boolean);
  out(lines.join('\n'));
}

async function serve(config) {
  const logger = createLogger(config.logLevel);
  const app = createApp(config, { logger });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } catch (err) {
      logger.debug(`shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logger.error(`port ${config.port} is already in use. Try --port ${config.port + 1}`);
      await app.close();
      return 1;
    }
    if (err.code === 'EACCES') {
      logger.error(`not allowed to bind ${config.host}:${config.port}`);
      await app.close();
      return 1;
    }
    await app.close();
    throw err;
  }

  banner(config, app.address());
  if (config.open) {
    const hostForDisplay = config.host === '0.0.0.0' ? config.lanAddress : '127.0.0.1';
    openBrowser(`http://${hostForDisplay}:${app.address().port}/`);
  }
  return new Promise(() => {});
}

async function bench(config) {
  const logger = createLogger(config.logLevel === 'silent' ? 'silent' : 'warn');
  const resolver = createResolver(config.resolver, { timeout: config.timeout, logger });
  out(`\n  Resolving ${config.benchHost} with ${resolver.enabled.length} resolvers `
    + `(${config.benchRounds} rounds each)...\n`);
  let result;
  try {
    result = await resolver.bench({ host: config.benchHost, rounds: config.benchRounds });
  } finally {
    resolver.close();
  }

  out(`  ${pad('RESOLVER', 26)}${pad('MEDIAN', 10)}${pad('BEST', 10)}SAMPLES`);
  out(`  ${'-'.repeat(58)}`);
  for (const row of result.results) {
    const marker = row.id === result.fastest ? '*' : ' ';
    const label = `${marker} ${row.label}${row.type === 'system' ? ' (plain)' : ''}`;
    const samples = row.samples.length ? row.samples.map((s) => s.toFixed(0)).join(', ') : (row.error || 'failed');
    out(`  ${pad(label.slice(0, 25), 26)}${pad(ms(row.medianMs), 10)}${pad(ms(row.bestMs), 10)}${samples}`);
  }
  out('');
  if (result.fastest) {
    const best = result.results.find((r) => r.id === result.fastest);
    out(`  Fastest: ${best.label} (${ms(best.medianMs)} median)`);
    out('  The proxy races resolvers automatically, so no configuration is needed.\n');
    return 0;
  }
  out('  No resolver answered. This network may block DNS-over-HTTPS (port 443).');
  out('  Try: wififree serve --resolver system\n');
  return 1;
}

function pac(config) {
  const host = config.pacHost || (config.host === '0.0.0.0' ? config.lanAddress : '127.0.0.1');
  const type = config.pacType || 'http';
  const port = type === 'socks5' ? config.socksPort : config.port;
  process.stdout.write(generatePac({
    host,
    port,
    type,
    bypass: config.bypass,
    proxyName: NAME
  }));
  return 0;
}

async function check(config) {
  const logger = createLogger('warn');
  out(`\n  ${NAME} ${VERSION} self-check\n`);
  let failures = 0;

  const resolver = createResolver(config.resolver, { timeout: config.timeout, logger });
  const host = 'example.com';

  try {
    const started = performance.now();
    const addresses = await resolver.getAddresses(host);
    const elapsed = performance.now() - started;
    const stats = resolver.stats();
    const winnerId = stats.lastWinner
      || (stats.resolvers.length === 1 ? stats.resolvers[0].id : null);
    const winner = stats.resolvers.find((r) => r.id === winnerId);
    out(`  [ok] DNS ${host} -> ${addresses.map((a) => a.address).join(', ') || 'no records'} `
      + `(${ms(elapsed)} via ${winner ? winner.label : stats.lastWinner || 'unknown'})`);
  } catch (err) {
    failures += 1;
    out(`  [FAIL] DNS lookup failed: ${err.message}`);
  }

  try {
    const info = await tcpTlsCheck(host, 443, resolver.lookup, config.timeout);
    out(`  [ok] HTTPS ${host}:443 ${info.protocol} via ${info.address} (${ms(info.ms)}, `
      + `cert ${info.authorized ? 'trusted' : 'untrusted'})`);
  } catch (err) {
    failures += 1;
    out(`  [FAIL] TLS connection failed: ${err.message}`);
  }

  // Boot the proxy on an ephemeral port and exercise the real code paths.
  const probe = createApp({
    ...config,
    host: '127.0.0.1',
    port: 0,
    socks: false,
    ui: true,
    logLevel: 'silent'
  }, { logger: createLogger('silent'), resolver });
  try {
    await probe.start();
    const base = `http://127.0.0.1:${probe.address().port}`;
    const health = await httpGet(`${base}/health`);
    const pacRes = await httpGet(`${base}/proxy.pac`);
    const status = await httpGet(`${base}/api/status`);
    const statusJson = JSON.parse(status.body.toString('utf8'));
    const pacOk = pacRes.body.toString('utf8').includes('FindProxyForURL');
    out(`  [ok] local proxy: /health ${health.status}, PAC ${pacOk ? 'valid' : 'invalid'}, `
      + `status ${statusJson.proxy ? 'valid' : 'invalid'}`);
    if (health.status !== 200 || !pacOk) failures += 1;
  } catch (err) {
    failures += 1;
    out(`  [FAIL] local proxy self-test failed: ${err.message}`);
  } finally {
    await probe.close();
    resolver.close();
  }

  out('');
  if (failures === 0) {
    out('  All checks passed. Start it with: wififree serve --lan\n');
    return 0;
  }
  out(`  ${failures} check(s) failed. See README troubleshooting.\n`);
  return 1;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--version') || argv.includes('-v')) {
    out(VERSION);
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    out(usage());
    return 0;
  }

  let config;
  try {
    config = normalizeConfig(argv);
  } catch (err) {
    process.stderr.write(`wififree: ${err.message}\n\n${usage()}`);
    return 2;
  }

  switch (config.command) {
    case 'serve':
      return serve(config);
    case 'bench':
      return bench(config);
    case 'pac':
      return pac(config);
    case 'check':
      return check(config);
    case 'help':
      out(usage());
      return 0;
    default:
      process.stderr.write(`wififree: unknown command "${config.command}"\n\n${usage()}`);
      return 2;
  }
}

module.exports = {
  main,
  serve,
  bench,
  pac,
  check,
  banner
};
