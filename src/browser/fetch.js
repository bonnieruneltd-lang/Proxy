'use strict';

const http = require('node:http');
const net = require('node:net');
const https = require('node:https');
const zlib = require('node:zlib');

const MAX_REDIRECTS = 5;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'upgrade-insecure-requests': '1'
};

const REPLAYABLE = new Set(['GET', 'HEAD']);

function openUpstream({
  url,
  method = 'GET',
  headers = {},
  body = null,
  resolver,
  timeout = 15000,
  agents,
  redirects = MAX_REDIRECTS
}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`invalid URL: ${url}`));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`unsupported protocol ${target.protocol}`));
      return;
    }

    const secure = target.protocol === 'https:';
    const mod = secure ? https : http;
    const requestHeaders = { ...DEFAULT_HEADERS, ...headers };
    requestHeaders.host = target.host;
    if (body) requestHeaders['content-length'] = String(body.length);

    const options = {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      lookup: resolver.lookup,
      agent: agents ? (secure ? agents.https : agents.http) : undefined
    };
    if (secure && !net.isIP(options.hostname)) options.servername = options.hostname;

    const req = mod.request(options, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirects > 0) {
        res.resume();
        let next;
        try {
          next = new URL(location, target).href;
        } catch (err) {
          reject(new Error(`invalid redirect location: ${location}`));
          return;
        }
        const keepMethod = status === 307 || status === 308 || REPLAYABLE.has(method);
        openUpstream({
          url: next,
          method: keepMethod ? method : 'GET',
          headers: keepMethod ? headers : {},
          body: keepMethod ? body : null,
          resolver,
          timeout,
          agents,
          redirects: redirects - 1
        }).then(resolve, reject);
        return;
      }
      resolve({ res, finalUrl: target.href });
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`upstream timed out after ${timeout}ms`));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function decompress(stream, encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (value === 'gzip' || value === 'x-gzip') return stream.pipe(zlib.createGunzip());
  if (value === 'deflate') return stream.pipe(zlib.createInflate());
  if (value === 'br') return stream.pipe(zlib.createBrotliDecompress());
  return stream;
}

function readAll(stream, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy(new Error(`response larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decodeText(buffer, contentType) {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (err) {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function isHtml(contentType) {
  const value = String(contentType || '').toLowerCase();
  return value.includes('text/html') || value.includes('application/xhtml+xml');
}

function isCss(contentType) {
  return String(contentType || '').toLowerCase().includes('text/css');
}

module.exports = {
  openUpstream,
  decompress,
  readAll,
  decodeText,
  charsetOf,
  isHtml,
  isCss,
  DEFAULT_HEADERS,
  BROWSER_UA,
  MAX_REDIRECTS
};
