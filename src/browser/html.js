'use strict';

const {
  absolutize,
  parseAttrs,
  serializeAttrs,
  getAttr,
  setAttr,
  hasAttr,
  escapeAttr,
  decodeEntities,
  rewriteSrcset,
  rewriteCss
} = require('./rewrite');

const STASH_RE = /\u0000WF(\d+)\u0000/g;

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  return decodeEntities(match[1].replace(/\s+/g, ' ').trim()).slice(0, 300);
}

function rewriteTag(tagName, source, ctx) {
  const name = String(tagName).toLowerCase();
  let attrs = parseAttrs(source);
  let extra = '';

  if (name === 'base') return { drop: true, extra: '' };

  if (name === 'meta') {
    const equiv = String(getAttr(attrs, 'http-equiv') || '').toLowerCase();
    if (equiv === 'content-security-policy') return { drop: true, extra: '' };
    if (equiv === 'refresh') {
      const content = getAttr(attrs, 'content');
      const match = content ? /url\s*=\s*(.+)$/i.exec(content) : null;
      if (match) {
        const abs = absolutize(ctx.pageUrl, match[1].replace(/^['"]|['"]$/g, ''));
        if (abs) setAttr(attrs, 'content', content.replace(match[1], ctx.browse(abs)));
      }
    }
    return { attrs, extra };
  }

  if (name === 'a' || name === 'area') {
    const href = getAttr(attrs, 'href');
    const abs = absolutize(ctx.pageUrl, href);
    if (abs) setAttr(attrs, 'href', ctx.browse(abs));
  }

  if (name === 'link') {
    const href = getAttr(attrs, 'href');
    const abs = absolutize(ctx.pageUrl, href);
    if (abs) setAttr(attrs, 'href', ctx.raw(abs));
  }

  if (name === 'img' || name === 'script' || name === 'source' || name === 'track'
    || name === 'embed' || name === 'audio' || name === 'video' || name === 'input') {
    const src = getAttr(attrs, 'src');
    const abs = absolutize(ctx.pageUrl, src);
    if (abs) setAttr(attrs, 'src', ctx.raw(abs));

    const srcset = getAttr(attrs, 'srcset');
    if (srcset) setAttr(attrs, 'srcset', rewriteSrcset(srcset, ctx.pageUrl, ctx.raw));

    const poster = getAttr(attrs, 'poster');
    if (poster !== undefined) {
      const posterUrl = absolutize(ctx.pageUrl, poster);
      if (posterUrl) setAttr(attrs, 'poster', ctx.raw(posterUrl));
    }

    if (name === 'img') {
      if (!hasAttr(attrs, 'loading')) setAttr(attrs, 'loading', 'lazy');
      if (!hasAttr(attrs, 'decoding')) setAttr(attrs, 'decoding', 'async');
    }
  }

  if (name === 'iframe' || name === 'frame') {
    const src = getAttr(attrs, 'src');
    const abs = absolutize(ctx.pageUrl, src);
    if (abs) setAttr(attrs, 'src', ctx.browse(abs));
    return { attrs, extra };
  }

  if (name === 'object') {
    const abs = absolutize(ctx.pageUrl, getAttr(attrs, 'data'));
    if (abs) setAttr(attrs, 'data', ctx.raw(abs));
  }

  if (name === 'form') {
    const action = getAttr(attrs, 'action');
    const method = String(getAttr(attrs, 'method') || 'get').toLowerCase();
    const abs = absolutize(ctx.pageUrl, action == null || action === '' ? ctx.pageUrl : action);
    if (abs) {
      if (method === 'post') {
        setAttr(attrs, 'action', ctx.browse(abs));
      } else {
        setAttr(attrs, 'action', ctx.browsePath);
        extra = `<input type="hidden" name="__url" value="${escapeAttr(abs)}">`;
      }
    }
  }

  const inlineStyle = getAttr(attrs, 'style');
  if (inlineStyle) setAttr(attrs, 'style', rewriteCss(inlineStyle, ctx.pageUrl, ctx.raw));

  return { attrs, extra };
}

/**
 * Rewrites an HTML document so it can be served and navigated from the proxy
 * origin. Returns the rewritten markup plus the page title.
 */
function rewriteHtml(html, pageUrl, options = {}) {
  const ctx = {
    pageUrl,
    browsePath: options.browsePath || '/browse',
    browse: (abs) => `${options.browsePath || '/browse'}?url=${encodeURIComponent(abs)}`,
    raw: (abs) => `${options.rawPath || '/raw'}?url=${encodeURIComponent(abs)}`
  };

  const source = String(html);
  const title = extractTitle(source);
  const stash = [];
  const hold = (content) => {
    stash.push(content);
    return `\u0000WF${stash.length - 1}\u0000`;
  };

  // Comments and raw-text elements are stashed so the tag scanner cannot
  // mistake their contents (inline JS, CSS strings) for markup.
  let doc = source.replace(/<!--[\s\S]*?-->/g, '');
  doc = doc.replace(
    /<(script|style|textarea)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
    (match, tag, attrs) => {
      const lower = tag.toLowerCase();
      const body = match.slice(match.indexOf('>') + 1, match.lastIndexOf('</'));
      const rewritten = lower === 'style' ? rewriteCss(body, pageUrl, ctx.raw) : body;
      const tagResult = rewriteTag(tag, attrs, ctx);
      if (tagResult.drop) return '';
      return hold(`<${tag}${serializeAttrs(tagResult.attrs)}>${tagResult.extra || ''}${rewritten}</${tag}>`);
    }
  );

  doc = doc.replace(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (full, tag, attrs) => {
    const result = rewriteTag(tag, attrs, ctx);
    if (result.drop) return result.extra || '';
    return `<${tag}${serializeAttrs(result.attrs)}>${result.extra || ''}`;
  });

  doc = doc.replace(STASH_RE, (match, index) => stash[Number(index)] || '');

  return { html: doc, title };
}

module.exports = { rewriteHtml, rewriteTag, extractTitle };
