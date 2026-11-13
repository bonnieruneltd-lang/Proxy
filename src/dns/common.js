'use strict';

const net = require('node:net');

const MIN_TTL = 5;
const MAX_TTL = 300;
const NEGATIVE_TTL = 20;
const TYPE_CODES = { A: 1, AAAA: 28, CNAME: 5 };

class DnsError extends Error {
  constructor(message, code = 'EDNS', extra = {}) {
    super(message);
    this.name = 'DnsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.$/, '');
}

function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return MIN_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.round(n)));
}

function sortAddresses(addresses) {
  const seen = new Set();
  const out = [];
  for (const entry of addresses) {
    if (!entry || !entry.address || seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  // IPv4 first: public Wi-Fi IPv6 is often advertised but blackholed.
  out.sort((a, b) => a.family - b.family);
  return out;
}

function isValidAddress(address, family) {
  return net.isIP(address) === family;
}

module.exports = {
  MIN_TTL,
  MAX_TTL,
  NEGATIVE_TTL,
  TYPE_CODES,
  DnsError,
  normalizeName,
  clampTtl,
  sortAddresses,
  isValidAddress
};
