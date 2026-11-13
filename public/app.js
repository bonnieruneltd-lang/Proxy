'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;

  function humanBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1000) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = value / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function humanDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function setStatus(mode, text) {
    const dot = $('status-dot');
    dot.className = `dot ${mode}`;
    $('status-text').textContent = text;
  }

  function renderResolvers(resolver) {
    const list = $('resolvers');
    list.textContent = '';
    const rows = [...(resolver.resolvers || [])].sort((a, b) => a.score - b.score);
    const leadId = resolver.lastWinner || (rows[0] && rows[0].id);
    rows.forEach((row) => {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'name';
      const label = document.createElement('span');
      label.textContent = row.label;
      name.appendChild(label);

      if (row.id === leadId) {
        const tag = document.createElement('span');
        tag.className = 'tag lead';
        tag.textContent = 'last win';
        name.appendChild(tag);
      } else if (row.type === 'system') {
        const tag = document.createElement('span');
        tag.className = 'tag plain';
        tag.textContent = 'fallback';
        name.appendChild(tag);
      } else if (row.errors > 0 && row.ok === 0) {
        const tag = document.createElement('span');
        tag.className = 'tag slow';
        tag.textContent = 'failing';
        name.appendChild(tag);
      }

      const ms = document.createElement('span');
      ms.className = 'ms';
      ms.textContent = row.latencyMs == null ? 'measuring…' : `${row.latencyMs.toFixed(1)} ms`;

      li.append(name, ms);
      li.title = row.lastError || `${row.queries} queries, ${row.hits} cache hits`;
      list.appendChild(li);
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No resolvers configured.';
      list.appendChild(li);
    }
    $('resolver-winner').textContent = resolver.degraded
      ? 'system fallback'
      : `auto · ${rows.length} resolver${rows.length === 1 ? '' : 's'}`;
  }

  function renderHosts(hosts) {
    const list = $('hosts');
    list.textContent = '';
    if (!hosts || !hosts.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No traffic yet.';
      list.appendChild(li);
      return;
    }
    hosts.slice(0, 6).forEach((entry) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/browse?url=${encodeURIComponent(`https://${entry.host}/`)}`;
      link.textContent = entry.host;
      const count = document.createElement('span');
      count.textContent = String(entry.count);
      li.append(link, count);
      list.appendChild(li);
    });
  }

  function renderQuickLinks(links) {
    const wrap = $('quick-links');
    wrap.textContent = '';
    (links || []).forEach((item) => {
      const a = document.createElement('a');
      a.href = `/browse?url=${encodeURIComponent(item.url)}`;
      a.textContent = item.label;
      wrap.appendChild(a);
    });
  }

  function render(next) {
    const proxyHost = location.hostname || '127.0.0.1';
    $('proxy-address').textContent = `${proxyHost}:${next.proxy.port}`;
    $('socks-address').textContent = next.socks ? `${proxyHost}:${next.socks.port}` : 'disabled';
    $('pac-url').textContent = next.pac.url;
    $('version').textContent = `${next.name} ${next.version}`;

    $('stat-requests').textContent = String(next.stats.requests);
    $('stat-down').textContent = humanBytes(next.stats.bytesDown);
    $('stat-tunnels').textContent = String(next.stats.tunnels);
    $('stat-uptime').textContent = humanDuration(next.stats.uptimeSeconds);

    renderQuickLinks(next.quickLinks);
    renderResolvers(next.resolver);
    renderHosts(next.stats.topHosts);
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = await res.json();
      render(state);
      const degraded = state.resolver.degraded ? ' · system DNS fallback' : '';
      setStatus('on', `ready${degraded}`);
    } catch (err) {
      setStatus('off', 'proxy not reachable');
    }
  }

  function normalizeInput(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(text) && !text.includes(' ')) return `https://${text}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  }

  function openInBrowser(value) {
    const url = normalizeInput(value);
    if (!url) return;
    location.href = `/browse?url=${encodeURIComponent(url)}`;
  }

  async function runBench() {
    const button = $('bench');
    const box = $('bench-result');
    button.disabled = true;
    button.textContent = 'Testing…';
    box.hidden = true;
    try {
      const res = await fetch('/api/bench?rounds=3', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      box.textContent = '';
      const table = document.createElement('table');
      const head = document.createElement('tr');
      ['Resolver', 'Median', 'Best'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        head.appendChild(th);
      });
      table.appendChild(head);
      data.results.forEach((row) => {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = row.id === data.fastest ? `${row.label} *` : row.label;
        const median = document.createElement('td');
        median.className = 'mono';
        median.textContent = row.medianMs == null ? 'failed' : `${row.medianMs.toFixed(1)} ms`;
        const best = document.createElement('td');
        best.className = 'mono';
        best.textContent = row.bestMs == null ? '-' : `${row.bestMs.toFixed(1)} ms`;
        tr.append(name, median, best);
        table.appendChild(tr);
      });
      box.appendChild(table);
      if (data.fastest) {
        const note = document.createElement('p');
        note.className = 'muted';
        note.textContent = `Fastest: ${data.fastest}. Racing stays on, so lookups always use whichever is quickest.`;
        box.appendChild(note);
      }
      box.hidden = false;
      loadStatus();
    } catch (err) {
      box.hidden = false;
      box.textContent = `Speed test failed: ${err.message}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Run speed test';
    }
  }

  function wireCopyButtons() {
    document.querySelectorAll('.copy').forEach((button) => {
      button.addEventListener('click', async () => {
        const key = button.dataset.copy;
        const map = {
          proxy: $('proxy-address').textContent,
          socks: $('socks-address').textContent,
          pac: $('pac-url').textContent
        };
        const value = map[key];
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
        } catch (err) {
          const area = document.createElement('textarea');
          area.value = value;
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        const original = button.textContent;
        button.textContent = 'Copied';
        button.classList.add('done');
        setTimeout(() => {
          button.textContent = original;
          button.classList.remove('done');
        }, 1400);
      });
    });
  }

  $('address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    openInBrowser($('address').value);
  });

  $('bench').addEventListener('click', runBench);

  wireCopyButtons();
  setStatus('', 'connecting…');
  loadStatus();
  setInterval(loadStatus, 5000);
})();
