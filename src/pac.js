'use strict';

function pacQuote(value) {
  return JSON.stringify(String(value));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  // Mirrors the browser's shExpMatch(): '*' matches any run, '?' one character.
  const parts = String(pattern)
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegex(char)));
  return new RegExp(`^${parts.join('')}$`);
}

/**
 * Minimal matcher used by the proxy itself (and tests) so behaviour can be
 * verified without a browser evaluating the PAC file.
 */
function matchesPattern(host, pattern) {
  const target = String(host || '').toLowerCase();
  const value = String(pattern || '').toLowerCase();
  if (!target || !value) return false;
  return globToRegExp(value).test(target);
}

function shouldBypass(host, bypass = []) {
  const target = String(host || '').toLowerCase();
  if (!target) return true;
  if (target === 'localhost' || target === '127.0.0.1' || target === '::1') return true;
  if (!target.includes('.')) return true; // plain host names (intranet boxes)
  return bypass.some((pattern) => matchesPattern(target, pattern));
}

/**
 * Builds a Proxy Auto-Config script.
 * `type` is "http" (PROXY) or "socks5" (SOCKS5).
 */
function generatePac({
  host = '127.0.0.1',
  port = 8085,
  type = 'http',
  bypass = [],
  failOpen = true,
  proxyName = 'wififree'
} = {}) {
  const patterns = Array.from(new Set(
    bypass
      .filter((pattern) => pattern != null && String(pattern).trim())
      .map((pattern) => String(pattern).trim())
  ));
  const patternsJs = patterns.map((p) => `    ${pacQuote(p)}`).join(',\n');
  const directive = type === 'socks5' ? `SOCKS5 ${host}:${port}` : `PROXY ${host}:${port}`;
  const fallback = failOpen ? '; DIRECT' : '';

  return `// ${proxyName} PAC script - generated ${new Date().toISOString()}
// Proxy: ${directive}
function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "DIRECT";
  }
  var BYPASS = [
${patternsJs}
  ];
  for (var i = 0; i < BYPASS.length; i++) {
    if (shExpMatch(host, BYPASS[i])) return "DIRECT";
  }
  // Captive-portal and connectivity probes must stay direct so the Wi-Fi
  // login page keeps working.
  if (/^(10|127)\\./.test(host) || /^192\\.168\\./.test(host) || /^169\\.254\\./.test(host) ||
      /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host)) {
    return "DIRECT";
  }
  return "${directive}${fallback}";
}
`;
}

module.exports = { generatePac, matchesPattern, shouldBypass, globToRegExp };
