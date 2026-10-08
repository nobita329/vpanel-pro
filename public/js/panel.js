window.VP = (() => {
  const state = { socket: null };

  function toast(msg, type = 'info') {
    let wrap = document.getElementById('toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toasts';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3200);
  }

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    const r = await fetch(url, o);
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtBytes(n) {
    if (n === 0) return '0 B';
    if (!n && n !== 0) return '—';
    let num = typeof n === 'string' ? parseFloat(n) : n;
    if (isNaN(num)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (num >= 1024 && i < units.length - 1) { num /= 1024; i++; }
    return `${num.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDate(s) {
    if (!s) return '-';
    return new Date(s).toLocaleString();
  }

  function confirmDialog(message, { danger = true, title = 'Are you sure?' } = {}) {
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay', style: 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.6);display:grid;place-items:center;' });
      const box = el('div', { class: 'modal', style: 'width:min(420px,92vw);background:var(--glass-strong);border:1px solid var(--border);border-radius:16px;padding:22px;backdrop-filter:blur(16px);' });
      box.appendChild(el('h3', { style: 'margin-bottom:10px' }, title));
      box.appendChild(el('p', { class: 'muted', style: 'margin-bottom:20px' }, message));
      const row = el('div', { class: 'flex right' });
      const cancel = el('button', { class: 'btn' }, 'Cancel');
      const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, 'Confirm');
      cancel.onclick = () => { overlay.remove(); resolve(false); };
      ok.onclick = () => { overlay.remove(); resolve(true); };
      row.append(cancel, ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  function hide(sel) { qsa(sel).forEach((x) => { x.style.display = 'none'; }); }
  function show(sel) { qsa(sel).forEach((x) => { x.style.display = ''; }); }

  document.addEventListener('DOMContentLoaded', () => {
    qsa('[data-confirm]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok2 = await confirmDialog(b.dataset.confirmMsg || 'This action cannot be undone.');
        if (ok2) {
          if (b.dataset.form) {
            document.getElementById(b.dataset.form).submit();
          } else {
            window.location = b.href;
          }
        }
      });
    });
  });

  function playSound(type) {
    try {
      const src = type === 'online' ? '/arix/online.mp3' : type === 'offline' ? '/arix/offline.mp3' : '/arix/copy.mp3';
      const a = new Audio(src);
      a.volume = 0.4;
      a.play().catch(() => {});
    } catch (_) {}
  }

  function copyText(t) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(t)
      .then(() => {
        playSound('copy');
        toast('Copied to clipboard!', 'success');
      })
      .catch(() => toast('Failed to copy', 'error'));
  }

  return { toast, api, qs, qsa, el, fmtBytes, fmtDate, confirmDialog, hide, show, state, playSound, copyText };
})();

(function () {
  const m = /(?:^|;\s*)theme=([^;]+)/.exec(document.cookie);
  const local = localStorage.getItem('arix_theme') || localStorage.getItem('vpanel_theme');
  const t = (m ? m[1] : null) || local || 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
