// Browse view: header + Genres menu, filter chips, sort, responsive card grid, A-Z jump rail.
// Every filter lives in the hash query (#/browse?type=&genre=&decade=&rating=&runtime=&unwatched=1&recent=1&sort=&letter=).
// Also exports helpers shared with the search view: norm, letterOf, makeCards.
import * as store from '../store.js';
import { el, icon, isTV } from '../util.js';
import { imgEl, imgUrl, placeholderEl } from '../img.js';

const TYPE_OF = { movie: 'Movie', series: 'Series' };
const SORTS = [
  ['az', 'A–Z'],
  ['added', 'Recently Added'],
  ['year', 'Year (newest)'],
  ['score', 'Score (highest)'],
  ['runtime', 'Runtime (longest)'],
];
const RUNTIMES = [
  ['lt90', 'Under 90 min'],
  ['90-120', '90–120 min'],
  ['gt120', 'Over 120 min'],
];
const RATING_ORDER = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'NR', 'Not Rated', 'Unrated'];
const LETTERS = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
const DAY = 864e5;
const RAIL_MIN_ITEMS = 24;
const CARD_SIZES = '(max-width:499px) 48vw, (max-width:799px) 32vw, (max-width:1099px) 24vw, (max-width:1399px) 19vw, 16vw';

// Focus to restore after the next mount (a filter change remounts the whole view).
let focusReq = null;

// ---- text + sort helpers (shared) ------------------------------------------------
// Lowercase, diacritic-free, apostrophes dropped, everything else collapsed to single spaces.
export function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

const skCache = new WeakMap();
// Sort key from sortName: titles starting with a-z sort by it; everything else sorts first under '#'.
function sortKey(it) {
  let k = skCache.get(it);
  if (k === undefined) {
    const n = norm(it.sortName || it.name);
    k = /^[a-z]/.test(n) ? n : '\u0000' + n;
    skCache.set(it, k);
  }
  return k;
}

export function letterOf(it) {
  const k = sortKey(it);
  return k.charCodeAt(0) === 0 ? '#' : k.charAt(0).toUpperCase();
}

function cmpKey(a, b) {
  const x = sortKey(a);
  const y = sortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function comparator(sort) {
  const num = (f) => (a, b) => {
    const x = f(a);
    const y = f(b);
    const mx = x == null || isNaN(x);
    const my = y == null || isNaN(y);
    if (mx && my) return cmpKey(a, b);
    if (mx) return 1;
    if (my) return -1;
    return (y - x) || cmpKey(a, b);
  };
  switch (sort) {
    case 'added': return num((it) => (it.added ? Date.parse(it.added) : null));
    case 'year': return num((it) => it.year);
    case 'score': return num((it) => it.score);
    case 'runtime': return num((it) => it.runtimeMin);
    default: return cmpKey;
  }
}

// ---- state <-> hash ----------------------------------------------------------------
function flag(v) { return v === '1' || v === 'true'; }

function readState(p) {
  const t = String(p.type || '').toLowerCase();
  const type = t === 'movie' || t === 'movies' ? 'movie'
    : t === 'series' || t === 'show' || t === 'shows' || t === 'tv' ? 'series' : '';
  const dec = parseInt(p.decade, 10);
  const letter = String(p.letter || '').trim().toUpperCase().slice(0, 1);
  return {
    type,
    genre: String(p.genre || ''),
    decade: isFinite(dec) && dec > 0 ? Math.floor(dec / 10) * 10 : 0,
    rating: String(p.rating || ''),
    runtime: RUNTIMES.some((r) => r[0] === p.runtime) ? p.runtime : '',
    unwatched: flag(p.unwatched),
    recent: flag(p.recent),
    sort: SORTS.some((s) => s[0] === p.sort) ? p.sort : 'az',
    letter: LETTERS.indexOf(letter) >= 0 ? letter : '',
  };
}

function hashFor(st) {
  const q = new URLSearchParams();
  if (st.type) q.set('type', st.type);
  if (st.genre) q.set('genre', st.genre);
  if (st.decade) q.set('decade', String(st.decade));
  if (st.rating) q.set('rating', st.rating);
  if (st.runtime) q.set('runtime', st.runtime);
  if (st.unwatched) q.set('unwatched', '1');
  if (st.recent) q.set('recent', '1');
  if (st.sort && st.sort !== 'az') q.set('sort', st.sort);
  const s = q.toString();
  return '#/browse' + (s ? '?' + s : '');
}

function hasFilters(st) {
  return !!(st.genre || st.decade || st.rating || st.runtime || st.unwatched || st.recent);
}

// ---- filtering -----------------------------------------------------------------------
function runtimeBucket(m) {
  if (!m) return '';
  return m < 90 ? 'lt90' : m <= 120 ? '90-120' : 'gt120';
}

function isUnwatched(it) {
  if (it.played) return false;
  if (it.type === 'Series' && it.episodes > 0 && it.unplayed === 0) return false;
  return true;
}

// `skip` leaves one facet out (used to count what each menu option WOULD yield).
function applyFilters(all, st, skip, now) {
  const g = st.genre.toLowerCase();
  const cut = now - 30 * DAY;
  const out = [];
  for (const it of all) {
    if (skip !== 'type' && st.type && it.type !== TYPE_OF[st.type]) continue;
    if (skip !== 'genre' && g && !(it.genres || []).some((x) => String(x).toLowerCase() === g)) continue;
    if (skip !== 'decade' && st.decade && (!it.year || Math.floor(it.year / 10) * 10 !== st.decade)) continue;
    if (skip !== 'rating' && st.rating && it.rating !== st.rating) continue;
    if (skip !== 'runtime' && st.runtime && runtimeBucket(it.runtimeMin) !== st.runtime) continue;
    if (st.unwatched && !isUnwatched(it)) continue;
    if (st.recent) {
      const t = it.added ? Date.parse(it.added) : NaN;
      if (!(t >= cut)) continue;
    }
    out.push(it);
  }
  return out;
}

function facet(all, st, key, now) {
  const m = new Map();
  const add = (v) => m.set(v, (m.get(v) || 0) + 1);
  for (const it of applyFilters(all, st, key, now)) {
    if (key === 'genre') { for (const g of new Set(it.genres || [])) add(g); }
    else if (key === 'decade') { if (it.year) add(Math.floor(it.year / 10) * 10); }
    else if (key === 'rating') { if (it.rating) add(it.rating); }
    else if (key === 'runtime') { const b = runtimeBucket(it.runtimeMin); if (b) add(b); }
    else if (key === 'type') add(it.type === 'Movie' ? 'movie' : 'series');
  }
  return m;
}

const ANY_LABEL = { genre: 'All genres', decade: 'Any decade', rating: 'Any rating', runtime: 'Any length', type: 'All titles' };

function optionsFor(key, all, st, now) {
  const counts = facet(all, st, key, now);
  const cur = st[key];
  const isCur = (v) => (key === 'genre' ? String(v).toLowerCase() === String(cur).toLowerCase() : v === cur);
  let entries = [];
  if (key === 'genre') {
    entries = [...counts.keys()].sort((a, b) => a.localeCompare(b)).map((v) => [v, v]);
  } else if (key === 'decade') {
    entries = [...counts.keys()].sort((a, b) => b - a).map((v) => [v, v + 's']);
  } else if (key === 'rating') {
    const rank = (r) => { const i = RATING_ORDER.indexOf(r); return i < 0 ? 999 : i; };
    entries = [...counts.keys()].sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b)).map((v) => [v, v]);
  } else if (key === 'runtime') {
    entries = RUNTIMES.filter((r) => counts.has(r[0])).map((r) => [r[0], r[1]]);
  } else if (key === 'type') {
    entries = [['movie', 'Movies'], ['series', 'Shows']];
  }
  const anyVal = key === 'decade' ? 0 : '';
  const total = applyFilters(all, st, key, now).length;
  const opts = [{ value: anyVal, label: ANY_LABEL[key], count: total, selected: !cur }];
  for (const [v, label] of entries) {
    const n = counts.get(v) || 0;
    const sel = isCur(v);
    if (!n && !sel) continue;
    opts.push({ value: v, label, count: n, selected: sel });
  }
  return opts;
}

function findGenre(all, g) {
  const l = g.toLowerCase();
  for (const it of all) for (const x of it.genres || []) if (String(x).toLowerCase() === l) return x;
  return '';
}

// ---- cards (also used by search) ------------------------------------------------------
function cardMedia(it) {
  for (const t of ['Backdrop', 'Thumb', 'Primary']) {
    if (imgUrl(it, t, 480)) return imgEl(it, t, 480, { sizes: CARD_SIZES, ws: [320, 480, 640, 960] });
  }
  return placeholderEl(it);
}

function openTitle(id) { location.hash = '#/title/' + encodeURIComponent(id); }

function buildCard(it) {
  const poster = it.type !== 'Episode' && imgUrl(it, 'Primary', 320)
    ? imgEl(it, 'Primary', 320, { sizes: CARD_SIZES, ws: [240, 320, 480] }) : null;   // lazy + hidden until "Posters" view
  if (poster) poster.classList.add('bcard-poster');
  const cap = el('div', { class: 'bcard-cap' }, el('div', { class: 'bcard-name' }, it.name || ''));
  const box = el('div', { class: 'bcard-img' }, cardMedia(it), poster, cap);
  // Same look as the home rows: the title's own logo over the art, falling back to plain text.
  const logoUrl = it.type === 'Episode' ? null : imgUrl(it, 'Logo', 240);
  if (logoUrl) {
    const logo = el('img', { class: 'card-logo bcard-logo', src: logoUrl, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    logo.addEventListener('error', () => { logo.remove(); box.classList.remove('has-logo'); }, { once: true });
    box.classList.add('has-logo');
    box.append(logo);
  }
  const label = (it.name || '') + (it.year ? ' (' + it.year + ')' : '');
  return el('div', {
    class: 'card bcard',
    tabindex: '0',
    role: 'link',
    'aria-label': label,
    dataset: { id: it.id, letter: letterOf(it) },
    onclick: () => openTitle(it.id),
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
    },
  }, box);
}

function syncCard(c) {
  const it = c.item;
  const pct = Math.max(0, Math.min(100, Math.round(it.playedPct || 0)));
  const sig = (it.played ? 'p' : '') + '|' + (it.played ? 0 : pct);
  if (c.sig === sig) return;
  c.sig = sig;
  const box = c.el.firstChild;
  const old = box.querySelectorAll('.bcard-prog, .bcard-seen');
  for (let i = 0; i < old.length; i++) old[i].remove();
  if (it.played) {
    box.appendChild(el('span', { class: 'bcard-seen', title: 'Watched', html: icon('check', 14) }));
  } else if (pct > 0 && pct < 100) {
    box.appendChild(el('div', { class: 'bcard-prog' }, el('i', { style: { width: pct + '%' } })));
  }
}

function setSub(c, sub) {
  if ((c.sub || '') === (sub || '')) return;
  c.sub = sub || '';
  const old = c.el.querySelector('.bcard-sub--below');
  if (old) old.remove();
  if (c.sub) c.el.appendChild(el('div', { class: 'bcard-sub bcard-sub--below' }, c.sub));   // under the art, not on it
}

// Card factory with a per-view cache so re-renders reuse DOM (and already-loaded images).
export function makeCards() {
  const map = new Map();
  return {
    get(it, sub) {
      let c = map.get(it.id);
      if (!c || c.item !== it) {
        c = { item: it, el: buildCard(it), sig: null, sub: '' };
        map.set(it.id, c);
      }
      setSub(c, sub);
      syncCard(c);
      return c.el;
    },
    sync(id) {
      const c = map.get(id);
      if (!c) return;
      const cur = store.get('byId').get(id);
      if (cur) c.item = cur;
      syncCard(c);
    },
  };
}

// ---- dropdown menus (popover on desktop/TV, bottom sheet on phones) ---------------------
function isSheet() {
  if (isTV()) return false;
  try { return window.matchMedia('(max-width: 739px)').matches; } catch { return false; }
}

function createMenus(layer) {
  let cur = null;

  function close(refocus) {
    if (!cur) return;
    const c = cur;
    cur = null;
    c.trigger.setAttribute('aria-expanded', 'false');
    c.trigger.classList.remove('is-open');
    document.removeEventListener('keydown', c.onKey, true);
    document.removeEventListener('focusin', c.onFocusIn, true);
    window.removeEventListener('scroll', c.onScroll);
    window.removeEventListener('resize', c.onResize);
    c.menu.remove();
    c.backdrop.remove();
    if (refocus && c.trigger.isConnected) c.trigger.focus({ preventScroll: true });
  }

  function place(menu, trigger, align) {
    if (isSheet()) return;
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = '';
    const w = menu.offsetWidth;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const top = r.bottom + 6;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.maxHeight = Math.max(160, vh - top - 12) + 'px';
  }

  function open(trigger, cfg) {
    const same = cur && cur.trigger === trigger;
    close(false);
    if (same) return;
    const cols = cfg.cols || 1;
    const items = cfg.options.map((o) => el('button', {
      type: 'button',
      class: 'bmenu-item' + (o.selected ? ' on' : ''),
      role: 'option',
      'aria-selected': o.selected ? 'true' : 'false',
      onclick: () => { close(false); cfg.onPick(o); },
    }, el('span', { class: 'bmenu-label' }, o.label), o.count != null ? el('span', { class: 'bmenu-count' }, String(o.count)) : null));

    const backdrop = el('div', { class: 'bmenu-backdrop', onclick: () => close(false) });
    const menu = el('div', {
      class: 'bmenu' + (cols > 1 ? ' cols' : ''),
      role: 'listbox',
      'aria-label': cfg.title,
      style: cols > 1 ? { '--mcols': String(cols) } : null,
    },
    el('div', { class: 'bmenu-head' },
      el('span', null, cfg.title),
      el('button', { type: 'button', class: 'bmenu-x', 'aria-label': 'Close', onclick: () => close(true), html: icon('close', 20) })),
    el('div', { class: 'bmenu-list' }, items));
    layer.appendChild(backdrop);
    layer.appendChild(menu);

    const onKey = (e) => {
      const k = e.key;
      if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || e.keyCode === 4 || e.keyCode === 27) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(true);
        return;
      }
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      if (!menu.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const n = items.length;
      let i = items.indexOf(document.activeElement);
      const step = cols > 1 ? Math.ceil(n / cols) : 0;
      if (k === 'ArrowDown') i = Math.min(n - 1, i + 1);
      else if (k === 'ArrowUp') i = Math.max(0, i - 1);
      else if (k === 'ArrowRight' && step && i + step < n) i += step;
      else if (k === 'ArrowLeft' && step && i - step >= 0) i -= step;
      if (items[i]) items[i].focus({ preventScroll: true });
      if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
    };
    const onFocusIn = (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) close(false);
    };
    const onScroll = () => { if (!isSheet()) close(false); };
    const onResize = () => close(false);

    cur = { trigger, menu, backdrop, onKey, onFocusIn, onScroll, onResize };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-open');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    place(menu, trigger, cfg.align);
    requestAnimationFrame(() => {
      menu.classList.add('show');
      backdrop.classList.add('show');
    });
    const sel = items.find((b) => b.classList.contains('on')) || items[0];
    if (sel) {
      sel.focus({ preventScroll: true });
      sel.scrollIntoView({ block: 'nearest' });
    }
  }

  return { open, close };
}

// ---- view options (layout / size / show), remembered per device ------------------------
const VIEW_KEY = 'myflix.browseView';
const VIEW_OPTS = {
  dir: ['Layout', [['grid', 'Grid (scroll down)'], ['row', 'Row (scroll sideways)']]],
  size: ['Size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]],
  show: ['Show', [['land', 'Landscape'], ['poster', 'Posters'], ['logo', 'Logos only']]],
};
function readView() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch {}
  const out = {};
  for (const k of Object.keys(VIEW_OPTS)) out[k] = VIEW_OPTS[k][1].some((o) => o[0] === v[k]) ? v[k] : VIEW_OPTS[k][1][k === 'size' ? 1 : 0][0];
  return out;
}
function applyView(root, v) {
  root.classList.toggle('bv-row', v.dir === 'row');
  root.classList.remove('bv-s', 'bv-l', 'bv-poster', 'bv-logo');
  if (v.size !== 'm') root.classList.add('bv-' + v.size);
  if (v.show !== 'land') root.classList.add('bv-' + v.show);
}

// ---- view ------------------------------------------------------------------------------
export function render(container, params = {}) {
  const st = readState(params);
  const all0 = store.get('index') || [];
  if (st.genre) st.genre = findGenre(all0, st.genre) || st.genre;

  const cards = makeCards();
  const unsubs = [];
  const reduced = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();

  const root = el('div', { class: 'browse' });
  const head = el('div', { class: 'bhead' });
  const chips = el('div', { class: 'bchips', role: 'toolbar', 'aria-label': 'Filters' });
  const rail = el('nav', { class: 'arail', 'aria-label': 'Jump to letter', hidden: true });
  const grid = el('div', { class: 'bgrid' });
  const status = el('div', { class: 'bstatus', hidden: true });
  const layer = el('div', { class: 'bmenu-layer' });
  const countEl = el('span', { class: 'bcount', 'aria-live': 'polite' });
  const menus = createMenus(layer);

  // -- navigation helpers --
  function restoreFocus(fk) {
    const t = root.querySelector('[data-fk="' + fk + '"]') || root.querySelector('[data-fk="genres"]');
    if (t) t.focus({ preventScroll: true });
  }

  function go(patch, fk) {
    const next = Object.assign({}, st, patch, { letter: '' });
    const h = hashFor(next);
    if (h === hashFor(st)) { restoreFocus(fk); return; }
    focusReq = { key: fk, at: Date.now() };
    location.hash = h;
  }

  function openFacet(key, trigger, title, cols, align) {
    const options = optionsFor(key, store.get('index') || [], st, Date.now());
    menus.open(trigger, { title, options, cols, align, onPick: (o) => go({ [key]: o.value }, trigger.dataset.fk) });
  }

  function dropBtn(cls, fk, labelNodes, onclick) {
    return el('button', {
      type: 'button', class: cls, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', dataset: { fk }, onclick,
    }, labelNodes, el('span', { class: 'bcaret', 'aria-hidden': 'true', html: icon('caret', 18) }));
  }

  // -- header: title, Genres menu, sort --
  const title = st.type === 'movie' ? 'Movies' : st.type === 'series' ? 'Shows' : 'Browse';
  head.appendChild(el('h1', { class: 'bhead-title' }, title,
    st.genre ? el('span', { class: 'bhead-crumb' }, el('span', { class: 'bhead-sep', 'aria-hidden': 'true' }, '›'), st.genre) : null));
  const genresBtn = dropBtn('bdrop' + (st.genre ? ' on' : ''), 'genres', el('span', null, 'Genres'),
    () => openFacet('genre', genresBtn, 'Genres', 3, 'left'));
  head.appendChild(genresBtn);
  head.appendChild(el('span', { class: 'bhead-spacer' }));
  const sortLabel = (SORTS.find((s) => s[0] === st.sort) || SORTS[0])[1];
  const sortBtn = dropBtn('bdrop bsort', 'sort',
    [el('span', { class: 'bsort-k' }, 'Sort by: '), el('span', { class: 'bsort-v' }, sortLabel)],
    () => menus.open(sortBtn, {
      title: 'Sort by',
      align: 'right',
      options: SORTS.map((s) => ({ value: s[0], label: s[1], selected: s[0] === st.sort })),
      onPick: (o) => go({ sort: o.value }, 'sort'),
    }));
  head.appendChild(sortBtn);

  // -- chips --
  function facetChip(key, label, on, menuTitle) {
    const b = dropBtn('bchip' + (on ? ' on' : ''), key, el('span', null, label), () => openFacet(key, b, menuTitle, 1, 'left'));
    return b;
  }
  function toggleChip(key, label, on) {
    return el('button', {
      type: 'button', class: 'bchip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', dataset: { fk: key },
      onclick: () => go({ [key]: !on }, key),
    }, label);
  }
  const rtLabel = (RUNTIMES.find((r) => r[0] === st.runtime) || [])[1];
  chips.appendChild(facetChip('type', st.type ? (st.type === 'movie' ? 'Movies' : 'Shows') : 'Type', !!st.type, 'Type'));
  chips.appendChild(facetChip('decade', st.decade ? st.decade + 's' : 'Decade', !!st.decade, 'Decade'));
  chips.appendChild(facetChip('rating', st.rating || 'Rating', !!st.rating, 'Rating'));
  chips.appendChild(facetChip('runtime', rtLabel || 'Runtime', !!st.runtime, 'Runtime'));
  const view = readView();
  applyView(root, view);
  for (const key of Object.keys(VIEW_OPTS)) {
    const [label, opts] = VIEW_OPTS[key];
    const shortOf = () => (opts.find((o) => o[0] === view[key]) || opts[0])[1].replace(/ \(.*\)/, '');
    const valEl = el('span', { class: 'bsort-v' }, shortOf());
    const vb = dropBtn('bchip bview', 'view-' + key, [el('span', { class: 'bsort-k' }, label + ': '), valEl], () => menus.open(vb, {
      title: label, align: 'left',
      options: opts.map((o) => ({ value: o[0], label: o[1], selected: o[0] === view[key] })),
      onPick: (o) => {
        view[key] = o.value;
        try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
        applyView(root, view);
        valEl.textContent = shortOf();
        vb.focus({ preventScroll: true });
      },
    }));
    chips.appendChild(vb);
  }
  chips.appendChild(toggleChip('unwatched', 'Unwatched', st.unwatched));
  chips.appendChild(toggleChip('recent', 'Added in last 30 days', st.recent));
  if (st.genre) {
    chips.appendChild(el('button', {
      type: 'button', class: 'bchip on has-x', dataset: { fk: 'genrechip' }, 'aria-label': 'Remove genre ' + st.genre,
      onclick: () => go({ genre: '' }, 'genres'),
    }, st.genre, el('span', { class: 'bchip-x', 'aria-hidden': 'true', html: icon('close', 14) })));
  }
  if (hasFilters(st)) {
    chips.appendChild(el('button', {
      type: 'button', class: 'bchip-clear', dataset: { fk: 'clear' },
      onclick: () => go({ genre: '', decade: 0, rating: '', runtime: '', unwatched: false, recent: false }, 'genres'),
    }, 'Clear all'));
  }
  chips.appendChild(countEl);

  // -- list state --
  let ids = [];
  let anchors = new Map();
  let activeLetter = '';
  let spyRaf = 0;
  let railBtns = new Map();

  function renderEmpty(n, total) {
    status.textContent = '';
    if (n) { status.hidden = true; return; }
    status.hidden = false;
    if (!total) {
      status.appendChild(el('div', { class: 'bempty' }, el('p', { class: 'bempty-t' }, 'Your library is empty.')));
      return;
    }
    status.appendChild(el('div', { class: 'bempty' },
      el('p', { class: 'bempty-t' }, 'No titles match these filters.'),
      hasFilters(st) ? el('button', {
        type: 'button', class: 'bchip', dataset: { fk: 'clear' },
        onclick: () => go({ genre: '', decade: 0, rating: '', runtime: '', unwatched: false, recent: false }, 'genres'),
      }, 'Clear filters') : null));
  }

  function offsetTop() {
    const nav = document.getElementById('nav');
    let off = (nav ? nav.offsetHeight : 64) + 12;
    try { if (getComputedStyle(rail).position === 'sticky') off += rail.offsetHeight; } catch {}
    return off;
  }

  function setActive(L) {
    if (L === activeLetter) return;
    const prev = railBtns.get(activeLetter);
    if (prev) prev.classList.remove('on');
    activeLetter = L;
    const b = railBtns.get(L);
    if (!b) return;
    b.classList.add('on');
    if (rail.scrollWidth > rail.clientWidth + 2) { // horizontal strip on phones
      rail.scrollLeft = b.offsetLeft - rail.clientWidth / 2 + b.offsetWidth / 2;
    }
  }

  function jump(L, instant) {
    let c = anchors.get(L);
    if (!c) {
      for (let k = LETTERS.indexOf(L) + 1; k < LETTERS.length && !c; k++) c = anchors.get(LETTERS[k]);
    }
    if (!c) return;
    const y = c.getBoundingClientRect().top + window.scrollY - offsetTop();
    window.scrollTo({ top: Math.max(0, y), behavior: instant || reduced ? 'auto' : 'smooth' });
    for (const k of LETTERS) if (anchors.get(k) === c) { setActive(k); break; }
  }

  function onScroll() {
    if (spyRaf || rail.hidden) return;
    spyRaf = requestAnimationFrame(() => {
      spyRaf = 0;
      const off = offsetTop() + 6;
      let cur = '';
      let first = '';
      for (const L of LETTERS) {
        const c = anchors.get(L);
        if (!c) continue;
        if (!first) first = L;
        if (c.getBoundingClientRect().top <= off) cur = L; else break;
      }
      setActive(cur || first);
    });
  }

  function buildRail(n) {
    const show = st.sort === 'az' && n >= RAIL_MIN_ITEMS;
    rail.hidden = !show;
    root.classList.toggle('has-rail', show);
    rail.textContent = '';
    railBtns = new Map();
    activeLetter = '';
    if (!show) return;
    for (const L of LETTERS) {
      const b = el('button', {
        type: 'button',
        class: 'arail-btn',
        dataset: { l: L },
        disabled: !anchors.has(L),
        'aria-label': L === '#' ? 'Numbers and symbols' : 'Jump to ' + L,
        tabindex: isTV() ? '0' : '-1',
        onclick: () => jump(L, false),
      }, L);
      railBtns.set(L, b);
      rail.appendChild(b);
    }
    onScroll();
  }

  function refreshList(force) {
    const all = store.get('index') || [];
    const items = applyFilters(all, st, null, Date.now()).sort(comparator(st.sort));
    const nextIds = items.map((i) => i.id);
    const same = !force && nextIds.length === ids.length && nextIds.every((v, i) => v === ids[i]);
    if (same) { for (const id of nextIds) cards.sync(id); return; }
    ids = nextIds;
    anchors = new Map();
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const c = cards.get(it);
      frag.appendChild(c);
      const L = letterOf(it);
      if (!anchors.has(L)) anchors.set(L, c);
    }
    grid.textContent = '';
    grid.appendChild(frag);
    grid.hidden = !items.length;
    countEl.textContent = items.length + (items.length === 1 ? ' title' : ' titles');
    renderEmpty(items.length, all.length);
    buildRail(items.length);
  }

  root.appendChild(head);
  root.appendChild(chips);
  root.appendChild(rail);
  root.appendChild(grid);
  root.appendChild(status);
  root.appendChild(layer);
  container.appendChild(root);
  refreshList(true);

  // Jump to ?letter= (external links), unless the user is mid-restore of a scroll position.
  if (st.letter && st.sort === 'az') requestAnimationFrame(() => jump(st.letter, true));

  if (focusReq && Date.now() - focusReq.at < 4000) restoreFocus(focusReq.key);
  focusReq = null;

  unsubs.push(store.on('index:updated', () => refreshList(true)));
  unsubs.push(store.on('item:changed', () => refreshList(false)));
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  return () => {
    menus.close(false);
    unsubs.forEach((u) => u());
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (spyRaf) cancelAnimationFrame(spyRaf);
  };
}
