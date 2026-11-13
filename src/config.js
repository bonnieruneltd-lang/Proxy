'use strict';

const os = require('node:os');

const VERSION = require('../package.json').version;
const NAME = 'wififree';

// Hosts that should never be tunnelled: local networks and captive-portal
// probes. Keeping these direct means the Wi-Fi login page still loads.
const DEFAULT_BYPASS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '10.*',
  '172.16.*',
  '172.17.*',
  '172.18.*',
  '172.19.*',
  '172.2?.*',
  '172.30.*',
  '172.31.*',
  '192.168.*',
  '169.254.*',
  '*.local',
  '*.lan',
  '*.home.arpa',
  'connectivitycheck.gstatic.com',
  'connectivitycheck.android.com',
  'clients3.google.com',
  'captive.apple.com',
  'www.apple.com',
  'msftconnecttest.com',
  'www.msftconnecttest.com',
  'detectportal.firefox.com'
];

/**
 * Minimal dependency-free argv parser.
 * Supports: --flag, --key value, --key=value, --no-flag, repeated flags.
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = true;
    }
    if (key.startsWith('no-') && (value === true || value === '')) {
      out[key.slice(3)] = false;
      continue;
    }
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

function toBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function parseAuth(raw) {
  if (!raw || raw === true) return null;
  const value = String(raw);
  const colon = value.indexOf(':');
  if (colon <= 0) throw new Error('--auth must look like "user:password"');
  return { user: value.slice(0, colon), pass: value.slice(colon + 1) };
}

function parseList(raw) {
  if (!raw || raw === true) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function localIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push(entry.address);
    }
  }
  // Prefer classic private ranges that phones on the same Wi-Fi can reach.
  const priv = candidates.find((a) => /^192\.168\./.test(a))
    || candidates.find((a) => /^10\./.test(a))
    || candidates.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return priv || candidates[0] || '127.0.0.1';
}

function normalizeConfig(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const command = args._[0] || (args.help ? 'help' : 'serve');
  const lan = toBool(args.lan, false);

  const config = {
    name: NAME,
    version: VERSION,
    command,
    host: String(args.host || env.WIFIFREE_HOST || (lan ? '0.0.0.0' : '127.0.0.1')),
    port: toInt(args.port, toInt(env.WIFIFREE_PORT, 8085, 1, 65535), 1, 65535),
    socks: toBool(args.socks, env.WIFIFREE_SOCKS !== '0'),
    socksHost: String(args['socks-host'] || env.WIFIFREE_SOCKS_HOST || (lan ? '0.0.0.0' : '127.0.0.1')),
    socksPort: toInt(args['socks-port'], toInt(env.WIFIFREE_SOCKS_PORT, 1080, 1, 65535), 1, 65535),
    resolver: String(args.resolver || env.WIFIFREE_RESOLVER || 'auto'),
    auth: parseAuth(args.auth || env.WIFIFREE_AUTH),
    bypass: DEFAULT_BYPASS.concat(parseList(args.bypass)),
    timeout: toInt(args.timeout, 6000, 500, 60000),
    logLevel: String(args['log-level'] || env.WIFIFREE_LOG_LEVEL || 'info'),
    ui: toBool(args.ui, true),
    open: toBool(args.open, false),
    lan,
    lanAddress: localIPv4(),
    maxBodyBytes: toInt(args['max-body'], 16 * 1024 * 1024, 1024, 128 * 1024 * 1024),
    benchRounds: toInt(args.rounds, 3, 1, 20),
    benchHost: String(args.hostname || 'example.com'),
    pacHost: args['pac-host'] ? String(args['pac-host']) : null,
    pacType: args.type === 'socks5' ? 'socks5' : 'http',
    json: toBool(args.json, false)
  };

  return config;
}

function usage() {
  return `wififree ${VERSION} - proxy + fast browser for restrictive Wi-Fi networks

USAGE
  wififree serve [options]        Start the proxy, SOCKS5 server and browser UI
  wififree bench [options]        Measure DNS resolvers and pick the fastest
  wififree pac [options]          Print a PAC file for this proxy
  wififree check [options]        Run connectivity self-tests

OPTIONS (serve)
  --port <n>              HTTP proxy + web UI port            (default 8085)
  --socks-port <n>        SOCKS5 port                         (default 1080)
  --no-socks              Disable the SOCKS5 listener
  --host <addr>           Bind address for proxy + UI         (default 127.0.0.1)
  --lan                   Shorthand for --host 0.0.0.0 (share on your Wi-Fi)
  --auth user:pass        Require Proxy-Authorization / SOCKS5 credentials
  --resolver <list>       auto | system | cloudflare,google,quad9
  --bypass <hosts>        Extra hosts that must go DIRECT in the PAC file
  --timeout <ms>          Upstream + DNS timeout              (default 6000)
  --no-ui                 Disable the built-in browser UI
  --open                  Open the browser UI in your default browser
  --log-level <level>     silent|error|warn|info|debug        (default info)

OPTIONS (bench)
  --rounds <n>            Samples per resolver                (default 3)
  --hostname <name>       Name to resolve                      (default example.com)

OPTIONS (pac)
  --pac-host <addr>       Address browsers should use          (default LAN IP)
  --port <n>              Proxy port                           (default 8085)

EXAMPLES
  wififree serve --lan
  wififree serve --auth me:s3cret --lan
  wififree bench
  wififree pac --pac-host 192.168.1.20 > proxy.pac

Docs: https://github.com/bonnieruneltd-lang/Proxy
`;
}

module.exports = {
  NAME,
  VERSION,
  DEFAULT_BYPASS,
  parseArgs,
  normalizeConfig,
  usage,
  localIPv4
};
