'use strict';

const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { encodeQuery, parseWireAnswer } = require('./wire');

const {
  MIN_TTL,
  MAX_TTL,
  NEGATIVE_TTL,
  TYPE_CODES,
  DnsError,
  normalizeName,
  clampTtl,
  sortAddresses
} = require('./common');

const MAX_BODY = 64 * 1024;

function parseDohAnswer(data) {
  if (!data || typeof data.Status !== 'number') {
    throw new DnsError('malformed DNS-over-HTTPS response', 'EBADRESP');
  }
  if (data.Status === 3) {
    const question = data.Question && data.Question[0];
    return { addresses: [], ttl: NEGATIVE_TTL, status: 3, name: question ? question.name : '' };
  }
  if (data.Status !== 0) {
    throw new DnsError(`DNS response status ${data.Status}`, 'EDNSSTATUS', { status: data.Status });
  }
  const answers = Array.isArray(data.Answer) ? data.Answer : [];
  const addresses = [];
  let ttl = MAX_TTL;
  for (const rr of answers) {
    if (!rr || typeof rr.data !== 'string') continue;
    const family = rr.type === TYPE_CODES.A ? 4 : rr.type === TYPE_CODES.AAAA ? 6 : 0;
    if (!family) continue;
    const address = rr.data.trim();
    if (net.isIP(address) !== family) continue;
    addresses.push({ address, family });
    ttl = Math.min(ttl, clampTtl(rr.TTL));
  }
  return { addresses: sortAddresses(addresses), ttl: clampTtl(ttl), status: 0 };
}

function defaultAgent(secure) {
  const Ctor = secure ? https.Agent : http.Agent;
  return new Ctor({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 8 });
}

/**
 * A single DNS-over-HTTPS resolver (RFC 8484 JSON API).
 * Talks HTTPS directly to a bootstrap IP when one is configured, so the
 * lookup itself never depends on the Wi-Fi network's (possibly hijacked) DNS.
 */
class DohResolver {
  constructor({ id, label, endpoint, bootstrap = null, timeout = 4000, maxTtl = MAX_TTL, format = 'auto' }) {
    if (!endpoint) throw new Error('DohResolver requires an endpoint');
    this.id = id || endpoint;
    this.label = label || this.id;
    this.type = 'doh';
    this.endpoint = endpoint;
    this.bootstrap = bootstrap;
    this.timeout = timeout;
    this.maxTtl = maxTtl;
    this.format = format;
    this.workingFormat = format === 'auto' ? null : format;
    this.workingTransport = null;
    this.h2Sessions = new Map();
    this.lastWireError = null;
    this.enabled = true;
    this.cache = new Map();
    this.inflight = new Map();
    this.agent = defaultAgent(new URL(endpoint).protocol === 'https:');
    this.stats = {
      queries: 0,
      hits: 0,
      ok: 0,
      errors: 0,
      consecutiveFailures: 0,
      latencyMs: null,
      lastError: null,
      lastQueryAt: null
    };
  }

  get score() {
    const base = this.stats.latencyMs == null ? 400 : this.stats.latencyMs;
    return base + this.stats.consecutiveFailures * 2000;
  }

  _record(ms, err) {
    const stats = this.stats;
    stats.lastQueryAt = new Date().toISOString();
    if (err) {
      stats.errors += 1;
      stats.consecutiveFailures += 1;
      stats.lastError = err.message;
      return;
    }
    stats.ok += 1;
    stats.consecutiveFailures = 0;
    stats.lastError = null;
    if (Number.isFinite(ms)) {
      stats.latencyMs = stats.latencyMs == null ? ms : (stats.latencyMs * 0.7 + ms * 0.3);
    }
  }

  _requestOptions(url, accept = 'application/dns-json') {
    const secure = url.protocol === 'https:';
    const options = {
      method: 'GET',
      agent: this.agent,
      headers: {
        accept,
        'user-agent': 'wififree/1.0'
      },
      signal: AbortSignal.timeout(this.timeout)
    };
    if (this.bootstrap && !net.isIP(url.hostname)) {
      const boot = this.bootstrap;
      const family = net.isIP(boot);
      options.lookup = (hostname, opts, callback) => {
        if (opts && opts.all) return callback(null, [{ address: boot, family }]);
        return callback(null, boot, family);
      };
      if (secure) options.servername = url.hostname;
    }
    return { secure, options };
  }

  _request(url, accept) {
    const { secure, options } = this._requestOptions(url, accept);
    const mod = secure ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          reject(new DnsError(`${this.id} timed out after ${this.timeout}ms`, 'ETIMEDOUT'));
          return;
        }
        reject(err);
      };

      const req = mod.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(new DnsError(`${this.id} HTTP ${res.statusCode}`, 'EHTTP', { status: res.statusCode }));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            fail(new DnsError(`${this.id} response too large`, 'ETOOBIG'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
      });
      req.on('error', fail);
      req.end();
    });
  }

  async _fetchJson(name, type) {
    const url = new URL(this.endpoint);
    url.searchParams.delete('dns');
    url.searchParams.set('name', name);
    url.searchParams.set('type', type);
    if (!url.searchParams.has('ct')) url.searchParams.set('ct', 'application/dns-json');
    const body = await this._request(url, 'application/dns-json');
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (err) {
      throw new DnsError(`${this.id} returned invalid JSON`, 'EBADRESP');
    }
    return parseDohAnswer(parsed);
  }

  _wireUrl(name, type) {
    const url = new URL(this.endpoint);
    url.searchParams.delete('name');
    url.searchParams.delete('type');
    url.searchParams.delete('ct');
    url.searchParams.set('dns', encodeQuery(name, type).toString('base64url'));
    return url;
  }

  _h2Session(url) {
    const authority = `${url.protocol}//${url.host}`;
    const existing = this.h2Sessions.get(authority);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const options = {};
    if (this.bootstrap && !net.isIP(url.hostname)) {
      const boot = this.bootstrap;
      const family = net.isIP(boot);
      options.lookup = (hostname, opts, callback) => {
        if (opts && opts.all) return callback(null, [{ address: boot, family }]);
        return callback(null, boot, family);
      };
      options.servername = url.hostname;
    }
    const session = http2.connect(authority, options);
    session.on('error', () => this.h2Sessions.delete(authority));
    session.on('close', () => this.h2Sessions.delete(authority));
    // Never keep the process alive just because a DNS session is idle.
    if (typeof session.unref === 'function') session.unref();
    this.h2Sessions.set(authority, session);
    return session;
  }

  _fetchWireH2(name, type) {
    const url = this._wireUrl(name, type);
    const session = this._h2Session(url);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      const request = session.request({
        ':method': 'GET',
        ':path': `${url.pathname}${url.search}`,
        accept: 'application/dns-message',
        'user-agent': 'wififree/1.0'
      });

      const timer = setTimeout(() => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        finish(new DnsError(`${this.id} timed out after ${this.timeout}ms`, 'ETIMEDOUT'));
      }, this.timeout);

      let status = 0;
      request.on('response', (headers) => {
        status = Number(headers[':status']) || 0;
        if (status !== 200) {
          request.close(http2.constants.NGHTTP2_CANCEL);
          finish(new DnsError(`${this.id} HTTP ${status}`, 'EHTTP', { status }));
        }
      });

      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          request.close(http2.constants.NGHTTP2_CANCEL);
          finish(new DnsError(`${this.id} response too large`, 'ETOOBIG'));
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          finish(null, parseWireAnswer(Buffer.concat(chunks)));
        } catch (err) {
          finish(err);
        }
      });
      request.on('error', (err) => finish(err));
      request.end();
    });
  }

  async _fetchWire(name, type) {
    const url = this._wireUrl(name, type);
    const canUseH2 = url.protocol === 'https:' && this.workingTransport !== 'h1';

    if (canUseH2) {
      try {
        const value = await this._fetchWireH2(name, type);
        this.workingTransport = 'h2';
        return value;
      } catch (err) {
        if (this.workingTransport === 'h2' || err.code === 'ETIMEDOUT') throw err;
        this.lastWireError = `h2: ${err.message}`;
      }
    }

    const body = await this._request(url, 'application/dns-message');
    this.workingTransport = 'h1';
    return parseWireAnswer(body);
  }

  /**
   * RFC 8484 wire format is tried first (it is what most DoH servers speak);
   * endpoints that only implement the JSON API fall back automatically.
   */
  async _resolve(name, type) {
    if (this.format === 'json') return this._fetchJson(name, type);
    if (this.format === 'wire') return this._fetchWire(name, type);
    if (this.workingFormat === 'json') return this._fetchJson(name, type);
    if (this.workingFormat === 'wire') return this._fetchWire(name, type);

    try {
      const value = await this._fetchWire(name, type);
      this.workingFormat = 'wire';
      return value;
    } catch (wireErr) {
      this.lastWireError = wireErr.message;
      if (wireErr.code === 'ETIMEDOUT') throw wireErr;
      const value = await this._fetchJson(name, type);
      this.workingFormat = 'json';
      return value;
    }
  }

  async query(name, type = 'A') {
    const key = `${type}:${normalizeName(name)}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      this.stats.hits += 1;
      return cached.value;
    }
    if (cached) this.cache.delete(key);

    const running = this.inflight.get(key);
    if (running) return running;

    const started = performance.now();
    const task = (async () => {
      try {
        const value = await this._resolve(normalizeName(name), type);
        const ttl = Math.min(value.ttl, this.maxTtl);
        this.cache.set(key, { expires: Date.now() + ttl * 1000, value });
        this.stats.queries += 1;
        this._record(performance.now() - started, null);
        return value;
      } catch (err) {
        this._record(null, err);
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  close() {
    for (const session of this.h2Sessions.values()) {
      try {
        session.destroy();
      } catch (err) {
        // already gone
      }
    }
    this.h2Sessions.clear();
    if (this.agent && typeof this.agent.destroy === 'function') this.agent.destroy();
    this.cache.clear();
    this.inflight.clear();
  }
}

module.exports = {
  DnsError,
  DohResolver,
  parseDohAnswer,
  parseWireAnswer,
  normalizeName,
  clampTtl,
  sortAddresses,
  defaultAgent,
  MIN_TTL,
  MAX_TTL,
  NEGATIVE_TTL
};
