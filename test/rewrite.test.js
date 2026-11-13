'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteHtml, extractTitle } = require('../src/browser/html');
const { injectChrome, errorPage, STRIP_RESPONSE_HEADERS } = require('../src/browser/browse');
const { absolutize, rewriteCss, rewriteSrcset, escapeAttr } = require('../src/browser/rewrite');

const browse = (url) => `/browse?url=${encodeURIComponent(url)}`;
const raw = (url) => `/raw?url=${encodeURIComponent(url)}`;

test('absolutize resolves relative references and skips non-http schemes', () => {
  const base = 'https://news.example/world/story.html';
  assert.equal(absolutize(base, 'other.html'), 'https://news.example/world/other.html');
  assert.equal(absolutize(base, '/root.css'), 'https://news.example/root.css');
  assert.equal(absolutize(base, '//cdn.example/x.js'), 'https://cdn.example/x.js');
  assert.equal(absolutize(base, 'http://plain.example/a'), 'http://plain.example/a');
  assert.equal(absolutize(base, '#anchor'), null);
  assert.equal(absolutize(base, 'javascript:alert(1)'), null);
  assert.equal(absolutize(base, 'mailto:a@b.c'), null);
  assert.equal(absolutize(base, 'data:image/png;base64,AAA'), null);
  assert.equal(absolutize(base, '   '), null);
});

test('rewriteSrcset rewrites each candidate and keeps descriptors', () => {
  const result = rewriteSrcset('/a.png 1x, /b.png 2x', 'https://x.example/p/', raw);
  assert.equal(result, `${raw('https://x.example/a.png')} 1x, ${raw('https://x.example/b.png')} 2x`);
});

test('rewriteCss rewrites url() and @import but leaves data URIs alone', () => {
  const css = `
    .a { background: url("/bg.png"); }
    .b { background: url(data:image/gif;base64,AAAA); }
    .c { background: url(../up.png); }
    @import "extra.css";
  `;
  const out = rewriteCss(css, 'https://x.example/css/site.css', raw);
  assert.ok(out.includes(`url("${raw('https://x.example/bg.png')}")`));
  assert.ok(out.includes('url(data:image/gif;base64,AAAA)'));
  assert.ok(out.includes(`url("${raw('https://x.example/up.png')}")`));
  assert.ok(out.includes(`@import url("${raw('https://x.example/css/extra.css')}")`));
});

test('escapeAttr escapes quotes and ampersands', () => {
  assert.equal(escapeAttr('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
});

test('extractTitle decodes entities and collapses whitespace', () => {
  assert.equal(extractTitle('<title>\n  Hi &amp; bye  \n</title>'), 'Hi & bye');
  assert.equal(extractTitle('<html><body>no title</body></html>'), '');
});

test('injectChrome adds a toolbar, viewport and the target URL', () => {
  const page = injectChrome('<html><head></head><body><p>hi</p></body></html>', {
    pageUrl: 'https://news.example/a?b=1'
  });
  assert.ok(page.includes('id="wf-bar"'));
  assert.ok(page.includes('name="viewport"'));
  assert.ok(page.includes('name="url" value="https://news.example/a?b=1"'));
  assert.ok(page.includes('/raw?url='), 'raw escape hatch is present');
  assert.ok(page.indexOf('id="wf-bar"') < page.indexOf('<p>hi</p>'), 'toolbar sits at the top');

  const fragment = injectChrome('<p>lonely</p>', { pageUrl: 'https://x.example/' });
  assert.ok(fragment.startsWith('<meta name="viewport"'));
  assert.ok(fragment.includes('id="wf-bar"'));
});

test('errorPage escapes the message and URL', () => {
  const page = errorPage({ title: '<script>', message: '<b>x</b>', url: 'https://x.example/?a=1&b=2' });
  assert.ok(page.includes('&lt;script&gt;'));
  assert.ok(page.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(page.includes('a=1&amp;b=2'));
});

test('STRIP_RESPONSE_HEADERS covers framing, cookies and CSP', () => {
  for (const header of ['set-cookie', 'content-security-policy', 'x-frame-options', 'content-length']) {
    assert.ok(STRIP_RESPONSE_HEADERS.has(header));
  }
});

test('rewriteHtml rewrites links, assets, forms, CSS and strips CSP', () => {
  const pageUrl = 'https://news.example/world/story.html';
  const source = `<!doctype html><html><head>
<base href="https://cdn.example/">
<title>  Hello &amp; welcome  </title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<meta http-equiv="refresh" content="5; url=/next">
<link rel="stylesheet" href="/style.css">
<style>.a{background:url('/bg.png')}</style>
<script>var s = '<a href="/should-not-rewrite">';</script>
</head><body>
<!-- a comment with <a href="/commented"> -->
<a href="other.html">relative</a>
<a href="#top">anchor</a>
<a href="javascript:void(0)">js</a>
<img src="/pic.png" srcset="/pic.png 1x, /pic2.png 2x">
<iframe src="/frame"></iframe>
<form action="/search" method="get"><input name="q"></form>
<form action="/post" method="post"><input name="x"></form>
<div style="background-image:url('/hero.jpg')"></div>
<video poster="/p.jpg"><source src="/v.mp4"></video>
</body></html>`;

  const { html, title } = rewriteHtml(source, pageUrl);

  assert.equal(title, 'Hello & welcome');
  assert.equal(html.includes('<base'), false, 'base tags are dropped');
  assert.equal(html.includes('Content-Security-Policy'), false, 'CSP meta is dropped');
  assert.equal(html.includes('a comment'), false, 'comments are stripped');

  assert.ok(html.includes(`href="${browse('https://news.example/world/other.html')}"`));
  assert.ok(html.includes('href="#top"'), 'anchors stay local');
  assert.ok(html.includes('href="javascript:void(0)"'), 'javascript: links stay untouched');
  assert.ok(html.includes(`href="${raw('https://news.example/style.css')}"`));

  assert.ok(html.includes(`src="${raw('https://news.example/pic.png')}"`));
  assert.ok(html.includes(`srcset="${raw('https://news.example/pic.png')} 1x, ${raw('https://news.example/pic2.png')} 2x"`));
  assert.ok(html.includes('loading="lazy"'), 'images are lazy loaded for speed');
  assert.ok(html.includes(`src="${browse('https://news.example/frame')}"`), 'iframes navigate through the client');

  assert.ok(html.includes('action="/browse"'), 'GET forms post to the client');
  assert.ok(html.includes('name="__url" value="https://news.example/search"'));
  assert.ok(html.includes(`action="${browse('https://news.example/post')}"`), 'POST forms keep their target');

  assert.ok(html.includes(`url("${raw('https://news.example/bg.png')}")`), 'style blocks are rewritten');
  assert.ok(
    html.includes(`background-image:url(&quot;${raw('https://news.example/hero.jpg')}&quot;)`),
    'style attributes are rewritten (CSS quotes are entity-escaped inside the attribute)'
  );
  assert.ok(html.includes(`poster="${raw('https://news.example/p.jpg')}"`));
  assert.ok(html.includes(`src="${raw('https://news.example/v.mp4')}"`));
  assert.ok(html.includes(`content="5; url=${browse('https://news.example/next')}"`), 'meta refresh is rewritten');

  assert.ok(html.includes("var s = '<a href=\"/should-not-rewrite\">';"), 'inline script is untouched');
});

test('rewriteHtml handles documents without head or body', () => {
  const { html } = rewriteHtml('<p><a href="http://a.example/">x</a></p>', 'http://b.example/');
  assert.ok(html.includes(`href="${browse('http://a.example/')}"`));
});
