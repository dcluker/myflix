// Live TV: an old-school channel guide. Channels are rows, time runs left to right in 30-minute columns, each
// programme is a block as wide as it is long. A block (or its channel) opens the channel in the player via /play/<id>.
import { el, toast } from '../util.js';
import { getLiveTv, playUrl } from '../api.js';
import { openLivePlayer, isNativeApp } from '../components/liveplayer.js';

const PM = 0.17;            // rem per minute: a 30-minute column is 5.1rem
const SLOT = 30 * 60;       // seconds per column

const fmt = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const rem = (sec) => (sec / 60) * PM;
const href = (id) => { const u = playUrl(id); return u + (u.includes('?') ? '&' : '?') + 'live=1'; };

function ruler(w0, slots) {
  const r = el('div', { class: 'gd-ruler', 'aria-hidden': 'true' });
  for (let i = 0; i < slots; i++) {
    const t = w0 + i * SLOT;
    r.append(el('span', { class: 'gd-tick', style: `left:${rem(i * SLOT)}rem;width:${rem(SLOT)}rem` }, fmt(t)));
  }
  return r;
}

function initials(name) {
  const w = String(name || '').replace(/\(.*?\)/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '')[1] || '')).toUpperCase();
}

function chanCol(c) {
  const wrap = el('span', { class: 'gd-logo-wrap' });
  const fallback = () => { wrap.classList.add('nologo'); wrap.replaceChildren(el('span', { class: 'gd-init' }, initials(c.name))); };
  if (c.tag) {
    const logo = el('img', { class: 'gd-logo', alt: '', loading: 'lazy', src: `/img/${encodeURIComponent(c.id)}/Primary?tag=${encodeURIComponent(c.tag)}&w=160` });
    logo.addEventListener('error', fallback);
    wrap.append(logo);
  } else { fallback(); }
  return el('div', { class: 'gd-ch' }, el('div', { class: 'gd-chc' + (c.lean === 'L' ? ' lean-l' : c.lean === 'R' ? ' lean-r' : '') },
    wrap, el('span', { class: 'gd-name' + (Math.max(...String(c.name).split(/\s+/).map((w) => w.length)) > 11 ? ' long' : '') }, c.name)));
}

function row(c, w0, w1, t0) {
  const cells = el('div', { class: 'gd-cells', style: `width:${rem(w1 - w0)}rem` });
  const list = (c.progs || []).filter((p) => p.e > w0 && p.s < w1);
  // Guide data can run out or have holes: fill them so a row is never blank space.
  const filled = [];
  let at = w0;
  for (const p of list) {
    if (p.s - at >= 60) filled.push({ s: at, e: p.s, ph: 1 });
    filled.push(p);
    at = Math.max(at, p.e);
  }
  if (w1 - at >= 60) filled.push({ s: at, e: w1, ph: 1 });
  for (const p of filled) {
    const s = Math.max(p.s, w0), e = Math.min(p.e, w1);
    const on = p.s <= t0 && t0 < p.e;
    const title = p.ph ? 'Live' : p.t;
    cells.append(el('a', {
      class: 'gd-cell' + (p.ph ? ' ph' : '') + (on ? ' on' : ''), href: href(c.id), 'data-fk': c.id + ':' + p.s, 'data-cid': c.id, 'data-now': c.now || '',
      style: `left:${rem(s - w0)}rem;width:${Math.max(rem(e - s) - 0.4, 0.6)}rem`,
      'aria-label': `${c.name}: ${title}${p.ph ? '' : ', ' + fmt(p.s) + ' to ' + fmt(p.e)}`, title: `${c.name}: ${title}`,
      'data-ch': c.name, 'data-pt': p.ph ? '' : p.t, 'data-ps': p.s, 'data-pe': p.e,
    }, el('span', { class: 'gd-txt' }, el('span', { class: 'gd-title' }, title), p.ph ? null : el('span', { class: 'gd-time' }, fmt(p.s)))));
  }
  return el('div', { class: 'gd-row' }, chanCol(c), cells);
}

const LEANS = [['L', 'Left', ' lean-l'], ['C', 'Center', ''], ['R', 'Right', ' lean-r']];
const LKEY = 'myflix.live.lean';
function loadLean() { try { return new Set(JSON.parse(localStorage.getItem(LKEY) || '[]').filter((k) => 'LCR'.includes(k))); } catch { return new Set(); } }

export function render(container) {
  const pick = loadLean();   // multi-select: none selected = show everything
  const keys = LEANS.map(([k, label, cls]) => {
    const b = el('button', { class: 'gd-key' + cls, type: 'button', 'aria-pressed': String(pick.has(k)), 'data-fk': 'lean:' + k }, label);
    b.addEventListener('click', () => {
      if (pick.has(k)) pick.delete(k); else pick.add(k);
      openGroups.clear();
      b.setAttribute('aria-pressed', String(pick.has(k)));
      try { localStorage.setItem(LKEY, JSON.stringify([...pick])); } catch {}
      draw();
    });
    return b;
  });
  const root = el('div', { class: 'gd' }, el('div', { class: 'gd-head' }, el('h1', { class: 'gd-h1' }, 'Live TV'),
    el('div', { class: 'gd-legend', role: 'group', 'aria-label': 'Filter news by political lean (pick any)' },
      el('span', { class: 'gd-filter-l' }, 'Filter'), ...keys)));
  container.appendChild(root);
  // Full channel name + programme title + time span for whatever is focused (grid cells are truncated).
  const infoCh = el('div', { class: 'gd-info-ch' });
  const infoTx = el('div', { class: 'gd-info-tx' });
  const info = el('div', { class: 'gd-info', 'aria-live': 'polite' }, infoCh, infoTx);
  root.append(info);
  const show = (e) => {
    const n = e.target && e.target.closest && e.target.closest('.gd-cell, .gd-chip');
    if (!n) return;
    if (n.classList.contains('gd-chip')) { infoCh.textContent = n.textContent; infoTx.textContent = 'No guide info'; return; }
    infoCh.textContent = n.dataset.ch || '';
    infoTx.textContent = n.dataset.pt ? `${n.dataset.pt}  ·  ${fmt(+n.dataset.ps)} – ${fmt(+n.dataset.pe)}` : 'Live';
  };
  root.addEventListener('focusin', show);
  // The grid scrolls inside its own frame (frozen ruler + channel column): reveal the focused block there ourselves.
  root.addEventListener('tv:reveal', (e) => {
    const n = e.target;
    if (!n || !n.closest || !n.closest('.gd-scroll')) return;
    e.preventDefault();
    try { n.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
  });
  root.addEventListener('mouseover', show);
  // Browsers play channels in the built-in player; the native apps (and middle/ctrl-click) keep following the link.
  root.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-cid]');
    if (!a || isNativeApp() || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const seen = new Map();
    root.querySelectorAll('a[data-cid]').forEach((n) => {
      if (n.offsetParent !== null && !seen.has(n.dataset.cid)) seen.set(n.dataset.cid, { id: n.dataset.cid, name: n.dataset.ch || '', now: n.dataset.now || '' });
    });
    const list = [...seen.values()];
    openLivePlayer(list, Math.max(0, list.findIndex((c) => c.id === a.dataset.cid)), a);
  });
  let alive = true;
  let timer = 0;
  let data = null;
  let scroller = null;
  let refreshTimer = 0;
  const openGroups = new Map();   // group -> open, so a refresh keeps what the person opened or closed

  const hasGuide = (c) => (c.progs || []).some((p) => !p.ph);
  const leanCls = (c) => (c.lean === 'L' ? ' lean-l' : c.lean === 'R' ? ' lean-r' : '');
  const OPEN = new Set(['Christmas', 'News', 'Weather']);

  function draw() {
    if (!data) return;
    clearInterval(timer);
    // Redrawn on a timer too: keep the place, the focus and the scroll.
    const keep = scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;
    const act = document.activeElement;
    const focusFk = act && scroller && scroller.contains(act) ? act.dataset.fk : null;
    const focusCid = focusFk ? act.dataset.cid : null;
    if (scroller) scroller.remove();
    const d = data;
    const filtering = pick.size > 0;
    // With a lean filter on, only channels rated that way are shown (non-political channels carry no lean).
    const chans = d.channels.filter((c) => !filtering || pick.has(c.lean));
    scroller = el('div', { class: 'gd-scroll' });
    root.insertBefore(scroller, info);
    if (!chans.length) { scroller.append(el('p', { class: 'gd-empty' }, 'No channels match that filter.')); return; }
    const t0 = d.t0 || Math.floor(Date.now() / 1000);
    const w0 = Math.floor(t0 / SLOT) * SLOT;
    const slots = Math.max(4, Math.round(((d.hours || 6) * 3600) / SLOT));
    const w1 = w0 + slots * SLOT;
    const inner = el('div', { class: 'gd-inner', style: `width:calc(9rem + ${rem(w1 - w0)}rem)` });
    // Groups (categories) are collapsible and built on first open, so ~1,200 channels stay light. Within a group,
    // channels with guide data are rows; the rest (no guide) are plain chips below them.
    for (const g of (d.groups || ['News'])) {
      const all = chans.filter((c) => c.group === g);
      if (!all.length) continue;
      const rows = all.filter(hasGuide), bare = all.filter((c) => !hasGuide(c));
      const body = el('div', { class: 'gd-body' });
      let built = false;
      const build = () => {
        if (built) return;
        built = true;
        body.append(...rows.map((c) => row(c, w0, w1, t0)));
        if (bare.length) {
          body.append(el('div', { class: 'gd-bare-wrap' }, el('div', { class: 'gd-bare-h' }, 'No guide info'),
            el('div', { class: 'gd-bare' }, ...bare.map((c) => el('a', { class: 'gd-chip' + leanCls(c), href: href(c.id), 'data-fk': c.id, 'data-cid': c.id, 'data-ch': c.name }, c.name)))));
        }
      };
      const head = el('button', { class: 'gd-gh', type: 'button', 'aria-expanded': 'false', 'data-fk': 'g:' + g },
        el('span', { class: 'gd-caret' }, '\u25B8'), el('span', { class: 'gd-gname' }, g), el('span', { class: 'gd-gcount' }, String(all.length)));
      const set = (open) => {
        if (open) build();
        openGroups.set(g, open);
        body.hidden = !open;
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        head.querySelector('.gd-caret').textContent = open ? '\u25BE' : '\u25B8';
      };
      head.addEventListener('click', () => set(body.hidden));
      set(openGroups.has(g) ? openGroups.get(g) : (filtering || OPEN.has(g)));
      inner.append(head, body);
    }
    inner.prepend(el('div', { class: 'gd-row gd-rulerrow' }, el('div', { class: 'gd-ch' }), ruler(w0, slots)));   // frozen top row
    const nowLine = el('div', { class: 'gd-now', 'aria-hidden': 'true' });
    const place = () => { nowLine.style.left = `calc(9rem + ${rem(Math.floor(Date.now() / 1000) - w0)}rem)`; };
    place();
    timer = setInterval(place, 30000);
    inner.append(nowLine);
    scroller.append(inner);
    if (keep) { scroller.scrollTop = keep.top; scroller.scrollLeft = 0; }   // time starts at "now" again after a refresh
    if (focusFk) {
      const esc = (v) => { try { return CSS.escape(v); } catch { return v; } };
      const n = scroller.querySelector('[data-fk="' + esc(focusFk) + '"]') || (focusCid && scroller.querySelector('[data-cid="' + esc(focusCid) + '"]'));
      if (n) { try { n.focus({ preventScroll: true }); } catch {} }
    }
  }

  getLiveTv().then((d) => {
    if (!alive) return;
    if (!((d && d.channels) || []).length) { root.insertBefore(el('p', { class: 'gd-empty' }, 'No live channels yet.'), info); return; }
    data = d;
    draw();
    // A TV can sit on this page for hours: keep the listings and the time window current.
    refreshTimer = setInterval(() => {
      if (document.body.classList.contains('lp-open') || document.hidden) return;
      getLiveTv().then((nd) => { if (alive && nd && (nd.channels || []).length) { data = nd; draw(); } }).catch(() => {});
    }, 5 * 60 * 1000);
  }).catch(() => { if (alive) toast('Could not load the guide'); });
  return () => { alive = false; clearInterval(timer); clearInterval(refreshTimer); };
}
