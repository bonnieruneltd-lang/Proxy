# wififree

**A proxy, an encrypted DNS resolver and a fast built-in browser in one
zero-dependency Node.js process — built for getting useful work done on
locked-down Wi-Fi.**

Hotels, airports, cafés, student housing and corporate guest networks often
give you an IP address and then filter DNS, block ports, or inject their own
answers. `wififree` gives you one command that:

- resolves names over **DNS-over-HTTPS** (RFC 8484 wire format over HTTP/2,
  with a JSON fallback; Cloudflare, Google and Quad9 raced in parallel so the
  fastest answer always wins),
- exposes an **HTTP/HTTPS `CONNECT` proxy** and a **SOCKS5 proxy** for every
  app on your machine or phone,
- generates a **PAC file** so browsers configure themselves,
- and serves a **built-in browser** that renders pages without a local browser
  engine, so you can read the web on the same device that runs the proxy.

```
                 ┌──────────────────────────── wififree ───────────────────────────┐
  browser/app ──▶│ :8085  HTTP proxy + CONNECT tunnels + browser UI + PAC          │
  phone      ──▶ │ :1080  SOCKS5 (CONNECT, username/password)                     │
                 │        DNS-over-HTTPS resolver (race + cache, IPv4-first)       │
                 │        HTML/CSS rewriter + streaming asset pass-through         │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │ encrypted DNS + direct TCP
                                            the open internet
```

## Why it is fast

| Technique | Effect |
| --- | --- |
| Resolver racing | Every lookup is sent to all encrypted resolvers at once; the first answer wins and slow resolvers are demoted (EWMA score). |
| Cache + in-flight de-duplication | Repeated names are answered from memory; concurrent lookups share one request. TTLs are honoured (5–300s). |
| Bootstrap IPs | DoH endpoints are dialled by IP with the correct SNI, so a hijacked local resolver cannot poison the lookup path. |
| HTTP/2 + keep-alive DoH | Wire-format queries reuse one multiplexed HTTP/2 session per resolver (Quad9 *requires* HTTP/2); JSON-only endpoints are detected and used automatically. |
| IPv4-first `lookup` | Node's Happy Eyeballs gets both families, IPv4 first, because IPv6 is often advertised but blackholed on public Wi-Fi. |
| Keep-alive pooling | Upstream HTTP/HTTPS sockets are reused for proxy traffic and asset fetches. |
| Streaming assets | Images, JS, fonts and media are piped byte-for-byte (no buffering); only HTML/CSS are rewritten. |
| Lazy images | Injected `loading="lazy"` + `decoding="async"` reduce initial payload. |

## Requirements

- Node.js 18+ (no npm install needed — there are **no dependencies**)
- Any OS: Linux, macOS, Windows, or a container

## Quick start

```bash
git clone https://github.com/bonnieruneltd-lang/Proxy.git
cd Proxy
node bin/wififree.js serve --lan
```

You will see:

```
  wififree 1.0.0 - proxy + fast browser for restrictive Wi-Fi

  Browser UI     http://192.168.1.20:8085/
  HTTP proxy     192.168.1.20:8085
  SOCKS5 proxy   socks5://192.168.1.20:1080
  PAC file       http://192.168.1.20:8085/proxy.pac
  DNS            auto (DNS-over-HTTPS, fastest resolver wins)
  Auth           open - add --auth user:pass before sharing
```

Open the browser UI to use the integrated browser, or point any browser/app at
the proxy. Prefer to install it as a command?

```bash
npm install -g .        # provides the `wififree` command
wififree serve --lan
```

No install at all:

```bash
npx --yes ./ serve --lan      # from a checkout
node bin/wififree.js serve    # 127.0.0.1 only, safest default
```

## Commands

```bash
wififree serve [--lan] [--auth user:pass] [--port 8085] [--socks-port 1080]
wififree bench [--rounds 3] [--hostname example.com]
wififree pac   [--pac-host 192.168.1.20] [--port 8085] > proxy.pac
wififree check
```

### `serve`

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8085` | HTTP proxy, PAC file and browser UI |
| `--socks-port <n>` | `1080` | SOCKS5 listener |
| `--no-socks` | off | Disable SOCKS5 |
| `--host <addr>` | `127.0.0.1` | Bind address for proxy + UI |
| `--lan` | off | Bind both listeners on `0.0.0.0` (share on your Wi-Fi) |
| `--auth user:pass` | off | Require `Proxy-Authorization` and SOCKS5 user/pass |
| `--resolver <list>` | `auto` | `auto`, `system`, `cloudflare`, `google`, `quad9`, or a DoH URL |
| `--bypass <hosts>` | built-in list | Extra hosts that must stay `DIRECT` |
| `--timeout <ms>` | `6000` | Upstream + DNS timeout |
| `--no-ui` | off | Proxy only (no browser UI) |
| `--open` | off | Open the UI in your default browser |
| `--log-level <l>` | `info` | `silent`, `error`, `warn`, `info`, `debug` |

### `bench`

Measures each resolver against a real name and prints median/best latency.
The proxy already races resolvers at runtime; `bench` is for showing the
numbers (and works offline with `--resolver system`).

```
  RESOLVER                  MEDIAN    BEST      SAMPLES
  ----------------------------------------------------------
  * Google DoH              4.6ms     3.6ms     4, 5, 23
    Quad9 DoH               12.5ms    12.5ms    13, 13, 42
    Cloudflare DoH          15.5ms    13.8ms    14, 16, 60
    System DNS (plain)      30.0ms    4.9ms     5, 30
```

### `pac`

Prints a Proxy Auto-Config script. Hosts that matter for connectivity
(`localhost`, RFC1918 ranges, `*.local`, captive-portal probes) stay `DIRECT`,
so the Wi-Fi sign-in page keeps working while everything else is tunnelled.

```bash
wififree pac --pac-host 192.168.1.20 > /etc/wififree.pac
```

### `check`

End-to-end self test: DoH lookup, TLS handshake through the resolved address,
and a local boot of the proxy (`/health`, `/proxy.pac`, `/api/status`).

```
  wififree 1.0.0 self-check

  [ok] DNS example.com -> 93.184.216.34, 2606:2800:... (18.2ms via Cloudflare DoH)
  [ok] HTTPS example.com:443 TLSv1.3 via 93.184.216.34 (63.4ms, cert trusted)
  [ok] local proxy: /health 200, PAC valid, status valid

  All checks passed. Start it with: wififree serve --lan
```

## Connect a device

### This computer

**Windows** — Settings → Network & Internet → Proxy → Manual proxy setup →
paste `127.0.0.1:8085` as the HTTP proxy (and use the same for HTTPS).

**macOS** — System Settings → Network → Details → Proxies → enable
*Web Proxy (HTTP)* and *Secure Web Proxy*, host `127.0.0.1`, port `8085`.

**Linux / CLI** —

```bash
export http_proxy=http://127.0.0.1:8085
export https_proxy=http://127.0.0.1:8085
curl https://example.com
```

**Firefox** (independent of the OS) — Settings → Network Settings → Automatic
proxy configuration URL → `http://127.0.0.1:8085/proxy.pac`.

### A phone on the same Wi-Fi

```bash
wififree serve --lan --auth me:s3cret
```

- **iOS**: Wi-Fi → (i) next to the network → Configure Proxy → Manual → server
  `192.168.1.20`, port `8085`, plus the username/password.
- **Android**: Wi-Fi → long-press the network → Modify → Advanced → Proxy →
  Manual → host `192.168.1.20`, port `8085`.

Find your address in the banner (or in the UI under *HTTP proxy*). SOCKS5 clients
should use port `1080` and `socks5h://` so names are resolved by the proxy.

### Verifying it works

```bash
curl -x http://127.0.0.1:8085 https://example.com -I   # CONNECT tunnel
curl --socks5-hostname 127.0.0.1:1080 https://example.com -I
wififree check
```

## The built-in browser

`/browse?url=https://…` fetches a page through the encrypted resolver, rewrites
it and serves it from the proxy origin:

- links and redirects → `/browse?url=…`
- images, scripts, styles, fonts, media → `/raw?url=…` (streamed untouched)
- CSS `url()` / `@import` → rewritten relative to the stylesheet
- GET forms → `/browse` with a hidden `__url` field; POST forms keep their body
- `meta refresh` → rewritten; CSP meta and upstream `Set-Cookie` stripped
- `<base>` removed, comments dropped, images lazy-loaded, viewport ensured
- a slim toolbar (back / forward / reload / home / address / raw) is injected

It is intentionally **not** a full browser engine: JavaScript-heavy apps,
`localStorage`, third-party logins and WebSockets inside the rewritten page are
limited. When a site does not work, use *raw* or point a real browser at the
proxy — that path is fully transparent (CONNECT tunnels, WebSockets, HTTP/2
upstream, downloads, streaming).

## Security

- Defaults are **loopback only**. `--lan` is opt-in because an open proxy on a
  public network lets anyone relay traffic through your machine.
- If you share it, add `--auth user:pass`. HTTP clients get `407` with
  `Proxy-Authenticate: Basic`; SOCKS5 uses RFC 1929 username/password.
  Credential checks are constant-time.
- The proxy does not log URLs at `info` level; `--log-level debug` does log
  connection targets, so avoid it on shared networks.
- DNS answers are still visible to your upstream network as TLS SNI unless you
  add a VPN; `wififree` defeats DNS-based filtering, not traffic analysis.
- Upstream `Set-Cookie`, CSP and `X-Frame-Options` headers are stripped from the
  built-in browser responses so they cannot escape their original origin.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` | Another process owns the port: use `--port 8086` (and `--socks-port 1081`). |
| Everything times out, `check` shows DNS failing | This network blocks DoH (443). Try `--resolver system`, or use a VPN/other network. |
| DoH works but pages hang | Outbound 443 may be filtered per host. Try `--timeout 15000`, test with `curl -x`. |
| Captive portal page does not appear | Visit `http://captive.apple.com` or `http://connectivitycheck.gstatic.com` directly — PAC keeps them `DIRECT`. |
| Phone cannot connect | Start with `--lan`, allow the port in the OS firewall, confirm both devices share a subnet. |
| `TLS handshake` errors in `check` | Something is intercepting TLS. Use the browser UI (server-side fetch) or a VPN. |
| SOCKS5 app fails | UDP ASSOCIATE and BIND are not implemented (returns `0x07`); use TCP-only apps or the HTTP proxy. |
| Sites break in the built-in browser | Use *raw*, or configure a real browser with the PAC file. |

## Development

```bash
npm test              # 63 tests: DoH (wire+JSON), proxy, SOCKS5, rewriting, PAC, CLI
npm run check         # live connectivity self-test
node bin/wififree.js serve --port 0 --open
```

Continuous integration is provided as a template at `ci/github-actions.yml`
(Node 18/20/22/24: unit tests, CLI smoke tests and a live proxy boot). Copy it
to `.github/workflows/ci.yml` if your repository token may create workflow
files:

```bash
mkdir -p .github/workflows && cp ci/github-actions.yml .github/workflows/ci.yml
```

Layout:

```
bin/wififree.js        CLI entry point
src/config.js          argv parsing, defaults, bypass list, usage text
src/cli.js             serve / bench / pac / check commands
src/server.js          HTTP server: proxy + UI + PAC + JSON API
src/dns/doh.js         DoH client (HTTP/2 + JSON), cache, EWMA scoring
src/dns/wire.js        RFC 1035 encoder/decoder for wire-format DoH
src/dns/common.js      shared DNSError, TTL + address helpers
src/dns/resolver.js    resolver racing, lookup(), benchmark
src/proxy/http.js      absolute-URI proxying, CONNECT tunnels, auth, upgrades
src/proxy/socks5.js    SOCKS5 handshake, auth, relay
src/browser/fetch.js   upstream fetch, redirects, gzip/br, decode
src/browser/html.js    tag/attribute rewriting
src/browser/rewrite.js URL/CSS helpers
src/browser/browse.js  /browse and /raw handlers, browser chrome
src/pac.js             PAC generation and glob matching
public/                the built-in browser UI (HTML/CSS/JS)
test/                  node:test suites
```

Design notes:

- No runtime dependencies, no build step, CommonJS only — it must run on a
  machine where `npm install` may itself be blocked.
- The HTTP proxy and the UI share one port: absolute-form request lines are
  proxied, origin-form requests hit the UI. That means a single port to forward
  through a firewall or SSH tunnel.
- All upstream sockets go through `resolver.lookup`, so nothing falls back to
  the system resolver unless you ask for it.
- HTML is rewritten with a tag scanner that stashes `<script>`, `<style>` and
  `<textarea>` bodies first, so inline code is never mistaken for markup.

## Docker

```bash
docker build -t wififree .
docker run --rm -p 8085:8085 -p 1080:1080 wififree serve --lan
```

The container binds `0.0.0.0`; publish the ports only on networks you trust and
add `--auth user:pass` when you do.

## Legal

Use `wififree` only on networks where you are permitted to do so, and respect
the operator's terms of service. It is a privacy and connectivity tool, not a
licence to bypass access controls you do not own.

## License

MIT — see [LICENSE](LICENSE).

