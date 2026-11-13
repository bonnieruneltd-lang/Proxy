'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { createResolver } = require('./dns/resolver');
const { createHttpProxy } = require('./proxy/http');
const { createSocks5Server } = require('./proxy/socks5');
const { handleBrowse, handleRaw, errorPage, sendHtml } = require('./browser/browse');
const { generatePac } = require('./pac');
const { createLogger } = require('./log');
const { VERSION, NAME, DEFAULT_BYPASS } = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const QUICK_LINKS = [
  { label: 'Wikipedia', url: 'https://www.wikipedia.org' },
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com' },
  { label: 'Hacker News', url: 'https://news.ycombinator.com' },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'Reddit', url: 'https://www.reddit.com' },
  { label: 'BBC News', url: 'https://www.bbc.com/news' }
];

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

const staticCache = new Map();

function readStatic(fileName) {
  if (staticCache.has(fileName)) return staticCache.get(fileName);
  const full = path.join(PUBLIC_DIR, fileName);
  let body = null;
  try {
    body = fs.readFileSync(full);
  } catch (err) {
    body = null;
  }
  staticCache.set(fileName, body);
  return body;
}

function createStats() {
  const hosts = new Map();
  const startedAt = Date.now();
  return {
    startedAt,
    requests: 0,
    completed: 0,
    errors: 0,
    authFailures: 0,
    connections: 0,
    tunnels: 0,
    bytesUp: 0,
    bytesDown: 0,
    recordHost(host) {
      if (!host) return;
      const key = String(host).toLowerCase();
      hosts.set(key, (hosts.get(key) || 0) + 1);
      if (hosts.size > 1000) {
        const oldest = hosts.keys().next().value;
        hosts.delete(oldest);
      }
    },
    topHosts(limit = 8) {
      return [...hosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([host, count]) => ({ host, count }));
    },
    snapshot() {
      return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        requests: this.requests,
        completed: this.completed,
        errors: this.errors,
        authFailures: this.authFailures,
        connections: this.connections,
        tunnels: this.tunnels,
        bytesUp: this.bytesUp,
        bytesDown: this.bytesDown,
        topHosts: this.topHosts(8)
      };
    }
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendStatic(res, fileName, req) {
  const body = readStatic(fileName);
  const type = STATIC_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  if (!body) {
    sendText(res, 404, 'not found\n');
    return;
  }
  const headers = {
    'content-type': type,
    'content-length': body.length,
    'cache-control': fileName === 'index.html' ? 'no-cache' : 'public, max-age=300'
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}


function requestHost(req, fallback) {
  const header = String(req.headers.host || '');
  if (!header) return fallback;
  const host = header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.split(':')[0];
  return host || fallback;
}

function browserContext(ctx) {
  return {
    resolver: ctx.resolver,
    timeout: ctx.config.timeout,
    maxBytes: ctx.config.maxBodyBytes,
    logger: ctx.logger,
    stats: ctx.stats,
    agents: ctx.agents
  };
}

async function handleRequest(req, res, ctx) {
  const { config, logger, stats, resolver, proxy, state } = ctx;
  const rawUrl = req.url || '/';

  // Absolute-form request line => this is being used as an HTTP proxy.
  if (/^https?:\/\//i.test(rawUrl)) {
    proxy.handleHttp(req, res);
    return;
  }

  let url;
  try {
    url = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    sendText(res, 400, 'wififree: bad request\n');
    return;
  }
  const pathname = url.pathname;
  const query = url.searchParams;

  if (pathname === '/browse' || pathname === '/raw') {
    if (!config.ui) {
      sendText(res, 404, 'wififree: the browser UI is disabled (--no-ui)\n');
      return;
    }
    const browseCtx = { ...browserContext(ctx), query };
    if (pathname === '/browse') await handleBrowse(req, res, browseCtx);
    else await handleRaw(req, res, browseCtx);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (!config.ui) {
      sendText(res, 200, [
        'wififree is running as a proxy (browser UI disabled).',
        '',
        `HTTP proxy : ${config.host}:${ctx.boundPort || config.port}`,
        `PAC file   : http://${requestHost(req, 'localhost')}:${ctx.boundPort || config.port}/proxy.pac`,
        ''
      ].join('\n'));
      return;
    }
    sendStatic(res, 'index.html', req);
    return;
  }

  if (pathname === '/styles.css' || pathname === '/app.js' || pathname === '/favicon.svg') {
    sendStatic(res, pathname.slice(1), req);
    return;
  }

  if (pathname === '/proxy.pac') {
    const boundPort = ctx.boundPort || config.port;
    const socksPort = ctx.boundSocksPort || config.socksPort;
    const type = query.get('type') === 'socks5' ? 'socks5' : 'http';
    const host = config.pacHost
      || (config.host === '0.0.0.0' ? requestHost(req, config.lanAddress) : '127.0.0.1');
    const pac = generatePac({
      host,
      port: type === 'socks5' ? socksPort : boundPort,
      type,
      bypass: config.bypass && config.bypass.length ? config.bypass : DEFAULT_BYPASS,
      proxyName: NAME
    });
    sendText(res, 200, pac, 'application/x-ns-proxy-autoconfig');
    return;
  }

  if (pathname === '/api/status') {
    const boundPort = ctx.boundPort || config.port;
    const hostName = config.host === '0.0.0.0' ? requestHost(req, config.lanAddress) : 'localhost';
    sendJson(res, 200, {
      name: NAME,
      version: VERSION,
      proxy: {
        host: config.host,
        port: boundPort,
        url: `http://${hostName}:${boundPort}`
      },
      socks: ctx.socksServer ? {
        host: config.socksHost,
        port: ctx.boundSocksPort || config.socksPort
      } : null,
      ui: {
        enabled: Boolean(config.ui),
        url: `http://${hostName}:${boundPort}/`
      },
      pac: {
        url: `http://${hostName}:${boundPort}/proxy.pac`,
        socksUrl: `http://${hostName}:${boundPort}/proxy.pac?type=socks5`
      },
      authRequired: Boolean(config.auth),
      quickLinks: QUICK_LINKS,
      resolver: resolver.stats(),
      stats: stats.snapshot()
    });
    return;
  }

  if (pathname === '/api/hosts') {
    sendJson(res, 200, { hosts: stats.topHosts(20) });
    return;
  }

  if (pathname === '/api/bench') {
    if (state.benchRunning) {
      sendJson(res, 409, { error: 'a benchmark is already running' });
      return;
    }
    state.benchRunning = true;
    try {
      const host = query.get('host') || config.benchHost || 'example.com';
      const rounds = Math.min(10, Math.max(1, Number(query.get('rounds')) || config.benchRounds || 3));
      const result = await resolver.bench({ host, rounds });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    } finally {
      state.benchRunning = false;
    }
    return;
  }

  if (pathname === '/api/resolve') {
    const name = query.get('name');
    if (!name) {
      sendJson(res, 400, { error: 'pass ?name=example.com' });
      return;
    }
    try {
      const addresses = await resolver.getAddresses(name);
      sendJson(res, 200, { name, addresses });
    } catch (err) {
      sendJson(res, 502, { error: err.message, code: err.code });
    }
    return;
  }

  if (pathname === '/health') {
    sendText(res, 200, 'ok\n');
    return;
  }

  if (pathname === '/robots.txt') {
    sendText(res, 200, 'User-agent: *\nDisallow: /\n');
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  logger.debug(`404 ${req.method} ${pathname}`);
  if (config.ui) {
    sendHtml(res, 404, errorPage({
      title: 'Page not found',
      message: `${pathname} is not part of wififree.`,
      url: null,
      details: 'This port is both the browser UI and an HTTP proxy. Configure your browser to use it as a proxy for other sites.'
    }));
  } else {
    sendText(res, 404, 'not found\n');
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function closeServer(server) {
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
 * Builds (but does not start) the proxy + browser app.
 */
function createApp(config = {}, deps = {}) {
  const logger = deps.logger || createLogger(config.logLevel || 'info');
  const resolver = deps.resolver || createResolver(config.resolver || 'auto', {
    timeout: config.timeout || 6000,
    logger
  });

  const stats = createStats();
  const agents = {
    http: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30000 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30000 })
  };
  const proxy = createHttpProxy({
    resolver,
    auth: config.auth || null,
    timeout: config.timeout || 6000,
    stats,
    logger
  });

  const ctx = {
    config,
    logger,
    stats,
    resolver,
    proxy,
    agents,
    state: { benchRunning: false },
    socksServer: null,
    boundPort: null,
    boundSocksPort: null
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      logger.debug(`request failed: ${err.stack || err.message}`);
      if (!res.headersSent) sendText(res, 500, 'wififree: internal error\n');
      else res.destroy();
    });
  });
  server.on('connect', (req, socket, head) => proxy.handleConnect(req, socket, head));
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  if (config.socks) {
    ctx.socksServer = createSocks5Server({
      resolver,
      auth: config.auth || null,
      stats,
      logger,
      idleTimeout: Math.max((config.timeout || 6000) * 10, 60000)
    });
  }

  const sockets = new Set();
  const track = (srv) => srv.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  track(server);
  if (ctx.socksServer) track(ctx.socksServer);

  return {
    config,
    logger,
    resolver,
    stats,
    proxy,
    server,
    ctx,
    get socksServer() {
      return ctx.socksServer;
    },
    async start() {
      await listen(server, config.port, config.host);
      ctx.boundPort = server.address().port;
      if (ctx.socksServer) {
        await listen(ctx.socksServer, config.socksPort, config.socksHost);
        ctx.boundSocksPort = ctx.socksServer.address().port;
      }
      logger.info(`${config.name || NAME} ${config.version || VERSION} listening on http://${config.host}:${ctx.boundPort}`);
      if (ctx.socksServer) {
        logger.info(`SOCKS5 reachable at socks5://${config.socksHost}:${ctx.boundSocksPort}`);
      }
      if (config.host === '0.0.0.0') {
        const note = config.auth ? 'authentication is required' : 'NO authentication - anyone on this Wi-Fi can use it';
        logger.warn(`bound to all interfaces: ${note}`);
      }
      return { port: ctx.boundPort, socksPort: ctx.boundSocksPort };
    },
    async close() {
      proxy.close();
      agents.http.destroy();
      agents.https.destroy();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all([
        closeServer(server),
        ctx.socksServer ? closeServer(ctx.socksServer) : Promise.resolve()
      ]);
      resolver.close();
    },
    address() {
      return {
        host: config.host,
        port: ctx.boundPort,
        socksHost: config.socksHost,
        socksPort: ctx.boundSocksPort
      };
    }
  };
}

module.exports = {
  createApp,
  createStats,
  handleRequest,
  listen,
  closeServer,
  QUICK_LINKS
};
