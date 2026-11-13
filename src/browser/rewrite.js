'use strict';

/**
 * Streaming-free, dependency-free HTML/CSS rewriter.
 *
 * Pages fetched by the built-in browser are rewritten so every link, form and
 * asset points back at the local proxy. That keeps the page usable without
 * sending it through a real browser engine, which is what makes it fast.
 */

const SKIP_SCHEME = /^(?:javascript|mailto|tel|data|blob|about|chrome|file|magnet|sms|geo):/i;
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function absolutize(base, ref) {
  if (ref == null) return null;
  const value = String(ref).trim();
  if (!value || value.startsWith('#')) return null;
  if (SKIP_SCHEME.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch (err) {
    return null;
  }
}

function parseAttrs(source) {
  const list = [];
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(source))) {
    const name = match[1];
    if (!name) continue;
    const value = match[2] !== undefined ? match[2]
      : match[3] !== undefined ? match[3]
        : match[4] !== undefined ? match[4]
          : null;
    list.push({ name, value });
  }
  return list;
}

function serializeAttrs(list) {
  return list.map((attr) => (
    attr.value == null ? ` ${attr.name}` : ` ${attr.name}="${escapeAttr(attr.value)}"`
  )).join('');
}

function getAttr(list, name) {
  const found = list.find((attr) => attr.name.toLowerCase() === name);
  return found ? found.value : undefined;
}

function setAttr(list, name, value) {
  const found = list.find((attr) => attr.name.toLowerCase() === name);
  if (found) found.value = value;
  else list.push({ name, value });
  return list;
}

function removeAttr(list, name) {
  return list.filter((attr) => attr.name.toLowerCase() !== name);
}

function hasAttr(list, name) {
  return list.some((attr) => attr.name.toLowerCase() === name);
}

function rewriteSrcset(value, base, wrap) {
  return String(value)
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const pieces = trimmed.split(/\s+/);
      const abs = absolutize(base, pieces[0]);
      if (!abs) return trimmed;
      return [wrap(abs), ...pieces.slice(1)].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

function rewriteCss(css, base, rawUrl) {
  const withUrls = String(css).replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, ref) => {
      const abs = absolutize(base, ref);
      return abs ? `url("${rawUrl(abs)}")` : match;
    }
  );
  return withUrls.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, quote, ref) => {
      const abs = absolutize(base, ref);
      return abs ? `@import url("${rawUrl(abs)}")` : match;
    }
  );
}

module.exports = {
  SKIP_SCHEME,
  escapeAttr,
  decodeEntities,
  absolutize,
  parseAttrs,
  serializeAttrs,
  getAttr,
  setAttr,
  removeAttr,
  hasAttr,
  rewriteSrcset,
  rewriteCss
};
