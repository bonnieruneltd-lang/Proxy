'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { DnsError, DohResolver, normalizeName, sortAddresses, NEGATIVE_TTL } = require('./doh');

const PRESETS = {
  cloudflare: {
    label: 'Cloudflare DoH',
    endpoint: 'https://cloudflare-dns.com/dns-query',
    bootstrap: '1.1.1.1',
    format: 'wire'
  },
  google: {
    label: 'Google DoH',
    // /resolve is Google's JSON API; /dns-query is wire-format only.
    endpoint: 'https://dns.google/resolve',
    bootstrap: '8.8.8.8',
    format: 'json'
  },
  quad9: {
    label: 'Quad9 DoH',
    endpoint: 'https://dns.quad9.net/dns-query',
    bootstrap: '9.9.9.9',
    format: 'wire'
  }
};

/**
 * Last-resort resolver using the operating system's configured DNS.
 * Only consulted when every encrypted resolver fails, because on a locked
 * down Wi-Fi this server is exactly the one that may be lying to us.
 */
class SystemResolver {
  constructor({ id = 'system', label = 'System DNS' } = {}) {
    this.id = id;
    this.label = label;
    this.type = 'system';
    this.enabled = true;
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
    return 5000 + this.stats.consecutiveFailures * 2000;
  }

  async query(name, type = 'A') {
    const hostname = normalizeName(name);
    const started = performance.now();
    this.stats.queries += 1;
    this.stats.lastQueryAt = new Date().toISOString();
    try {
      const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      const addresses = sortAddresses(
        found.filter((entry) => entry.family === (type === 'AAAA' ? 6 : 4))
      );
      this.stats.ok += 1;
      this.stats.consecutiveFailures = 0;
      this.stats.lastError = null;
      const ms = performance.now() - started;
      this.stats.latencyMs = this.stats.latencyMs == null ? ms : this.stats.latencyMs * 0.7 + ms * 0.3;
      return { addresses, ttl: 60, status: addresses.length ? 0 : 3 };
    } catch (err) {
      const fatal = err.code === 'ENOTFOUND' || err.code === 'ENODATA';
      this.stats.errors += 1;
      this.stats.consecutiveFailures += 1;
      this.stats.lastError = err.message;
      if (fatal) return { addresses: [], ttl: NEGATIVE_TTL, status: 3 };
      throw new DnsError(`system DNS failed for ${hostname}: ${err.message}`, err.code || 'ESYSTEM');
    }
  }

  close() {}
}

/**
 * Aggregates several resolvers and races them, so every lookup is answered by
 * whichever encrypted resolver is fastest right now. Slow or failing
 * resolvers are demoted automatically via an EWMA latency score.
 */
class Resolver {
  constructor({ resolvers, label = 'auto', logger = null } = {}) {
    if (!Array.isArray(resolvers) || !resolvers.length) {
      throw new Error('Resolver requires at least one resolver');
    }
    this.resolvers = resolvers;
    this.label = label;
    this.logger = logger;
    this.degraded = false;
    this.lastWinner = null;
    this.lookup = this.lookup.bind(this);
    this.lastFallbackLog = 0;
  }

  get enabled() {
    return this.resolvers.filter((r) => r && r.enabled !== false);
  }

  get dohResolvers() {
    return this.enabled.filter((r) => r.type === 'doh');
  }

  get systemResolvers() {
    return this.enabled.filter((r) => r.type === 'system');
  }

  async _race(list, name, type) {
    let lastErr = null;
    const winner = await Promise.any(
      list.map((r) => r.query(name, type).then(
        (value) => ({ value, resolver: r }),
        (err) => {
          lastErr = err;
          throw err;
        }
      ))
    ).catch((err) => {
      throw lastErr || err;
    });
    this.lastWinner = winner.resolver.id;
    if (this.degraded && winner.resolver.type === 'doh') this.degraded = false;
    return winner.value;
  }

  async query(name, type = 'A') {
    const doh = this.dohResolvers;
    const system = this.systemResolvers;
    if (doh.length) {
      try {
        return await this._race(doh, name, type);
      } catch (err) {
        if (!system.length) {
          this.degraded = true;
          throw err;
        }
        this.degraded = true;
        const now = Date.now();
        if (this.logger && now - this.lastFallbackLog > 30000) {
          this.lastFallbackLog = now;
          this.logger.warn(`all encrypted resolvers failed (${err.message}); falling back to system DNS`);
        }
        return system[0].query(name, type);
      }
    }
    if (!system.length) throw new DnsError('no DNS resolver available', 'ENORESOLVER');
    this.degraded = true;
    return system[0].query(name, type);
  }

  async getAddresses(hostname, family = 0) {
    const literal = net.isIP(hostname);
    if (literal) return [{ address: hostname, family: literal }];

    const wanted = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
    const settled = await Promise.allSettled(wanted.map((type) => this.query(hostname, type)));
    const addresses = [];
    let lastError = null;
    for (const result of settled) {
      if (result.status === 'fulfilled') addresses.push(...result.value.addresses);
      else lastError = result.reason;
    }
    if (!addresses.length && lastError) throw lastError;
    return sortAddresses(addresses).filter((a) => !family || a.family === family);
  }

  lookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    const family = Number(opts.family) || 0;

    if (net.isIP(hostname)) {
      const fam = net.isIP(hostname);
      if (opts.all) process.nextTick(() => cb(null, [{ address: hostname, family: fam }]));
      else process.nextTick(() => cb(null, hostname, fam));
      return;
    }

    this.getAddresses(hostname, family).then(
      (addresses) => {
        if (!addresses.length) {
          const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = 'ENOTFOUND';
          err.errno = -3008;
          err.syscall = 'getaddrinfo';
          err.hostname = hostname;
          cb(err);
          return;
        }
        if (opts.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, addresses[0].address, addresses[0].family);
      },
      (err) => cb(err)
    );
  }

  stats() {
    return {
      label: this.label,
      degraded: this.degraded,
      lastWinner: this.lastWinner,
      resolvers: this.enabled.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        format: r.type === 'doh' ? (r.workingFormat || r.format) : 'system',
        transport: r.type === 'doh' ? r.workingTransport : null,
        score: Math.round(r.score),
        latencyMs: r.stats.latencyMs == null ? null : Math.round(r.stats.latencyMs * 10) / 10,
        queries: r.stats.queries,
        hits: r.stats.hits,
        ok: r.stats.ok,
        errors: r.stats.errors,
        lastError: r.stats.lastError
      }))
    };
  }

  async bench({ host = 'example.com', rounds = 3 } = {}) {
    const results = [];
    for (const r of this.enabled) {
      const samples = [];
      let error = null;
      for (let i = 0; i < rounds; i += 1) {
        if (r.cache) r.cache.delete(`A:${normalizeName(host)}`);
        const started = performance.now();
        try {
          await r.query(host, 'A');
          samples.push(performance.now() - started);
        } catch (err) {
          error = err.message;
        }
      }
      samples.sort((a, b) => a - b);
      const median = samples.length ? samples[Math.floor(samples.length / 2)] : null;
      results.push({
        id: r.id,
        label: r.label,
        type: r.type,
        ok: samples.length === rounds,
        medianMs: median == null ? null : Math.round(median * 10) / 10,
        bestMs: samples.length ? Math.round(samples[0] * 10) / 10 : null,
        samples: samples.map((ms) => Math.round(ms * 10) / 10),
        error
      });
    }
    const ranked = results.sort((a, b) => (
      (a.medianMs == null ? Infinity : a.medianMs) - (b.medianMs == null ? Infinity : b.medianMs)
    ));
    return {
      host,
      rounds,
      results: ranked,
      fastest: ranked[0] && ranked[0].medianMs != null ? ranked[0].id : null
    };
  }

  close() {
    for (const r of this.resolvers) {
      if (r && typeof r.close === 'function') r.close();
    }
  }
}

function createResolver(spec = 'auto', { timeout = 4000, logger = null, includeSystem = true } = {}) {
  const ids = String(spec || 'auto').toLowerCase().split(/[,\s]+/).filter(Boolean);
  const auto = ids.length === 0 || ids.includes('auto');
  const chosen = auto ? Object.keys(PRESETS) : ids;
  const resolvers = [];

  for (const id of chosen) {
    if (id === 'auto') continue;
    if (id === 'system') {
      resolvers.push(new SystemResolver());
      continue;
    }
    if (PRESETS[id]) {
      resolvers.push(new DohResolver({ id, ...PRESETS[id], timeout }));
      continue;
    }
    if (/^https?:\/\//.test(id)) {
      resolvers.push(new DohResolver({ id: 'custom', label: 'Custom DoH', endpoint: id, timeout }));
      continue;
    }
    throw new Error(`unknown resolver "${id}" (use auto, system, cloudflare, google, quad9 or a DoH URL)`);
  }

  if (!resolvers.length) throw new Error('no DNS resolvers selected');
  if (includeSystem && !resolvers.some((r) => r.type === 'system')) {
    resolvers.push(new SystemResolver());
  }

  return new Resolver({ resolvers, label: spec, logger });
}

module.exports = { PRESETS, SystemResolver, Resolver, createResolver };

