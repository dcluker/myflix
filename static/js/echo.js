// Echo Hub: one horizontal row of titles for the Echo Show 5 launcher app. Sorts match Browse; a Cast-to menu picks the TV.
// Standalone entry (own page, /echo): reuses api.js / store.js / img.js only.
import * as store from './store.js';
import { getMe, getIndex, getHome, getItem, getSeason } from './api.js';
import { imgUrl } from './img.js';
import { initWake, getWake, saveWake, pauseWake, chime, wakeState, wakeLevel, getSens, setSens, setTest } from './echowake.js';

const SORTS = [
  ['continue', 'Continue Watching'],
  ['added', 'Recently Added'],
  ['az', 'A–Z'],
  ['year', 'Year (newest)'],
  ['score', 'Score (highest)'],
  ['runtime', 'Runtime (longest)'],
];
const TYPES = [['', 'All'], ['Movie', 'Movies'], ['Series', 'Shows']];
const RUNTIMES = [['lt90', 'Under 90 min'], ['90-120', '90–120 min'], ['gt120', 'Over 2 hours']];
const RATING_ORDER = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'NR', 'Not Rated', 'Unrated'];
const SIZES = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']];
const CARD_W = { s: 104, m: 150, l: 200 };   // poster width in css px
const LS = { sort: 'echo.sort', type: 'echo.type', target: 'echo.target', filt: 'echo.filters', view: 'echo.view' };
const PAGE = 36;   // cards rendered per batch; the Echo has ~1 GB of RAM

const $ = (id) => document.getElementById(id);
const bar = $('bar'), row = $('row'), layer = $('layer'), toastEl = $('toast');

const st = { sort: lsGet(LS.sort) || 'added', type: lsGet(LS.type) || '', target: lsGet(LS.target) || '',
  items: [], home: null, targets: [], shown: 0, list: [], q: '',
  f: { genre: '', decade: 0, rating: '', runtime: '', unwatched: false, recent: false, ...jget(LS.filt) },
  view: { dir: 'h', size: 'm', logos: false, ...jget(LS.view) } };
if (!CARD_W[st.view.size]) st.view.size = 'm';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function jget(k) { try { return JSON.parse(lsGet(k)) || {}; } catch { return {}; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

// Flat white icons (no emoji: the Echo draws those in colour). viewBox 24; currentColor.
const SVGNS = 'http://www.w3.org/2000/svg';
function ico(name, size = 24) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ico');
  const add = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); return n; };
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' };
  if (name === 'play') add('path', { d: 'M8 5.2v13.6c0 .6.7 1 1.2.6l10.2-6.8c.5-.3.5-1 0-1.3L9.2 4.6C8.7 4.2 8 4.6 8 5.2z', fill: 'currentColor' });
  else if (name === 'pause') { add('rect', { x: 6, y: 4.5, width: 4, height: 15, rx: 1.2, fill: 'currentColor' }); add('rect', { x: 14, y: 4.5, width: 4, height: 15, rx: 1.2, fill: 'currentColor' }); }
  else if (name === 'mic') {
    add('rect', { x: 9, y: 3, width: 6, height: 12, rx: 3, fill: 'currentColor' });
    add('path', Object.assign({ d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3' }, stroke));
  }
  else if (name === 'search') {
    add('circle', Object.assign({ cx: 10.5, cy: 10.5, r: 6.5 }, stroke));
    add('path', Object.assign({ d: 'M15.5 15.5L20.5 20.5' }, stroke));
  }
  else if (name === 'tune') {
    add('path', Object.assign({ d: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4.5v5M7 14.5v5' }, stroke));
  }
  else if (name === 'stop') add('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' });
  else if (name === 'next') { add('path', { d: 'M6 5.6v12.8c0 .6.6.9 1.1.6l8.3-6.4c.4-.3.4-.9 0-1.2L7.1 5c-.5-.3-1.1 0-1.1.6z', fill: 'currentColor' }); add('rect', { x: 16.6, y: 5, width: 2.6, height: 14, rx: 1.1, fill: 'currentColor' }); }
  else if (name === 'back10' || name === 'fwd10') {   // circular arrow with the 10-second step the TV player uses
    const g = add('g', name === 'fwd10' ? { transform: 'translate(24 0) scale(-1 1)' } : {});
    const a = document.createElementNS(SVGNS, 'path'); for (const k in stroke) a.setAttribute(k, stroke[k]); a.setAttribute('d', 'M12 5.2A8 8 0 1 1 4.1 13.4'); g.appendChild(a);
    const h = document.createElementNS(SVGNS, 'path'); h.setAttribute('d', 'M12.6 1.6v7.2L7.4 5.2z'); h.setAttribute('fill', 'currentColor'); g.appendChild(h);
    const t = add('text', { x: 12, y: 16, 'text-anchor': 'middle', 'font-size': 7.6, 'font-weight': 700, fill: 'currentColor', 'font-family': 'Helvetica Neue, Helvetica, Arial, sans-serif' }); t.textContent = '10';
  }
  return svg;
}

let toastT;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('on'), 2600);
}

// ---- sorting (same rules as Browse) --------------------------------------------------
function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function sortKey(it) {
  const n = norm(it.sortName || it.name);
  return /^[a-z]/.test(n) ? n : '\u0000' + n;
}
const cmpKey = (a, b) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; };
function byNum(f) {
  return (a, b) => {
    const x = f(a), y = f(b), mx = x == null || isNaN(x), my = y == null || isNaN(y);
    if (mx && my) return cmpKey(a, b);
    if (mx) return 1;
    if (my) return -1;
    return (y - x) || cmpKey(a, b);
  };
}
function comparator(sort) {
  switch (sort) {
    case 'added': return byNum((it) => (it.added ? Date.parse(it.added) : null));
    case 'year': return byNum((it) => it.year);
    case 'score': return byNum((it) => it.score);
    case 'runtime': return byNum((it) => it.runtimeMin);
    default: return cmpKey;
  }
}

function continueList() {
  const h = st.home || {};
  const seen = new Set(), out = [];
  for (const it of [...(h.resume || []), ...(h.nextUp || [])]) {
    const key = it.type === 'Episode' ? 's:' + it.seriesId : it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---- filters (same facets and rules as Browse) ---------------------------------------
const DAY = 864e5;
const runtimeBucket = (m) => (!m ? '' : m < 90 ? 'lt90' : m <= 120 ? '90-120' : 'gt120');
function isUnwatched(it) {
  if (it.played) return false;
  if (it.type === 'Series' && it.episodes > 0 && it.unplayed === 0) return false;
  return true;
}
function filtersOn() { const f = st.f; return !!(st.type || f.genre || f.decade || f.rating || f.runtime || f.unwatched || f.recent); }
function passes(it, f, now) {
  if (st.type && it.type !== st.type) return false;
  if (f.genre && !(it.genres || []).some((x) => String(x).toLowerCase() === f.genre.toLowerCase())) return false;
  if (f.decade && (!it.year || Math.floor(it.year / 10) * 10 !== f.decade)) return false;
  if (f.rating && it.rating !== f.rating) return false;
  if (f.runtime && runtimeBucket(it.runtimeMin) !== f.runtime) return false;
  if (f.unwatched && !isUnwatched(it)) return false;
  if (f.recent && !((it.added ? Date.parse(it.added) : NaN) >= now - 30 * DAY)) return false;
  return true;
}
function indexed(it) {   // Continue rows come from Home; judge them by their library entry (series for episodes)
  const id = it.type === 'Episode' ? it.seriesId : it.id;
  return st.byId.get(id) || it;
}

// ---- voice search: spoken text -> titles ---------------------------------------------
const FILLER = /^(?:(?:please|hey|ok|okay)\s+)*(?:(?:can you|could you)\s+)?(?:(?:play|watch|put on|show me|show|find|search for|search|look up|look for|i want to watch|i wanna watch|let'?s watch)\s+)+(?:(?:me|the movie|the show|the series|a movie|a show|movie|show|some)\s+)*/;
function cleanQuery(t) {
  return norm(t).replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim().replace(FILLER, '').replace(/^the\s+/, '').trim();
}
function titleMatches(it, q) {
  const toks = q.split(' ').filter(Boolean);
  if (!toks.length) return 0;
  const name = ' ' + norm(it.name).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const full = norm(it.name).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^the /, '');
  if (full === q) return 3;
  if (full.startsWith(q)) return 2.5;
  const hit = toks.filter((t) => name.includes(' ' + t) || (t.length > 3 && name.includes(t))).length;
  return hit === toks.length ? 2 : hit / toks.length >= 0.6 && toks.length > 2 ? 1 : 0;
}
function searchList() {
  const q = st.q, scored = [];
  for (const it of st.items) { const sc = titleMatches(it, q); if (sc) scored.push([sc, it]); }
  scored.sort((a, b) => (b[0] - a[0]) || cmpKey(a[1], b[1]));
  return scored.map((x) => x[1]);
}

function currentList() {
  if (st.q) return searchList();
  const now = Date.now();
  if (st.sort === 'continue') return continueList().filter((it) => passes(indexed(it), st.f, now));
  return st.items.filter((it) => passes(it, st.f, now)).sort(comparator(st.sort));
}
function saveFilters() { lsSet(LS.filt, JSON.stringify(st.f)); }
function saveView() { lsSet(LS.view, JSON.stringify(st.view)); }
function applyView() {
  const v = st.view, w = CARD_W[v.size];
  document.body.classList.toggle('vert', v.dir === 'v');
  document.body.classList.toggle('logos', !!v.logos);
  document.documentElement.style.setProperty('--cw', w + 'px');
  document.documentElement.style.setProperty('--ch', Math.round(w * 1.5) + 'px');
  document.documentElement.style.setProperty('--lw', Math.round(w * 1.45) + 'px');
  document.documentElement.style.setProperty('--lh', Math.round(w * 0.82) + 'px');
}

function facetOptions(key) {   // counts ignore the facet's own choice, like Browse
  const now = Date.now(), m = new Map(), f = { ...st.f, [key]: key === 'decade' ? 0 : '' };
  for (const it of st.items) {
    if (!passes(it, f, now)) continue;
    if (key === 'genre') for (const g of new Set(it.genres || [])) m.set(g, (m.get(g) || 0) + 1);
    else if (key === 'decade') { if (it.year) { const d = Math.floor(it.year / 10) * 10; m.set(d, (m.get(d) || 0) + 1); } }
    else if (key === 'rating') { if (it.rating) m.set(it.rating, (m.get(it.rating) || 0) + 1); }
    else if (key === 'runtime') { const b = runtimeBucket(it.runtimeMin); if (b) m.set(b, (m.get(b) || 0) + 1); }
  }
  let e;
  if (key === 'genre') e = [...m.keys()].sort((a, b) => a.localeCompare(b)).map((v) => [v, v]);
  else if (key === 'decade') e = [...m.keys()].sort((a, b) => b - a).map((v) => [v, v + 's']);
  else if (key === 'rating') { const rk = (r) => { const i = RATING_ORDER.indexOf(r); return i < 0 ? 999 : i; }; e = [...m.keys()].sort((a, b) => (rk(a) - rk(b)) || a.localeCompare(b)).map((v) => [v, v]); }
  else e = RUNTIMES.filter((r) => m.has(r[0]));
  return e.filter(([v]) => m.get(v) || String(st.f[key]).toLowerCase() === String(v).toLowerCase()).map(([v, l]) => [v, l, m.get(v) || 0]);
}

function openFilters() {
  closeMenu();
  const body = el('div', { class: 'fbody' });
  const count = el('span', {});
  const paint = () => {
    body.textContent = '';
    const group = (title, chips) => body.append(el('div', { class: 'fg' }, el('div', { class: 'fh' }, title), el('div', { class: 'chips' }, chips)));
    const chip = (label, on, fn) => el('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => { fn(); saveFilters(); renderRow(true); paint(); } }, label);
    group('Type', TYPES.map(([v, l]) => chip(l, st.type === v, () => { st.type = v; lsSet(LS.type, v); })));
    for (const [key, title, anyLabel] of [['genre', 'Genre', 'All'], ['decade', 'Decade', 'Any'], ['rating', 'Rating', 'Any'], ['runtime', 'Runtime', 'Any']]) {
      const any = key === 'decade' ? 0 : '';
      const opts = facetOptions(key);
      group(title, [chip(anyLabel, !st.f[key], () => { st.f[key] = any; }),
        ...opts.map(([v, l, n]) => chip(`${l} ${n}`, String(st.f[key]).toLowerCase() === String(v).toLowerCase() && !!st.f[key], () => { st.f[key] = st.f[key] === v ? any : v; }))]);
    }
    group('Show', [chip('Unwatched', st.f.unwatched, () => { st.f.unwatched = !st.f.unwatched; }),
      chip('Added in last 30 days', st.f.recent, () => { st.f.recent = !st.f.recent; })]);
    count.textContent = `Show ${st.list.length} title${st.list.length === 1 ? '' : 's'}`;
  };
  const clear = el('button', { class: 'btn plain', onclick: () => {
    st.f = { genre: '', decade: 0, rating: '', runtime: '', unwatched: false, recent: false }; st.type = ''; lsSet(LS.type, ''); saveFilters();
    renderRow(true); paint(); } }, 'Clear all');
  const done = el('button', { class: 'btn play', onclick: closeDetail }, count);
  paint();
  const sheet = el('div', { class: 'sheet fsheet' }, el('div', { class: 'fwrap' }, el('h1', {}, 'Filters'), body, el('div', { class: 'acts' }, clear, done)),
    el('button', { class: 'x', 'aria-label': 'Close', onclick: closeDetail }, '✕'));
  layer.textContent = '';
  layer.append(el('div', { class: 'dim', onclick: (e) => { if (e.target.classList.contains('dim')) closeDetail(); } }, sheet));
  // closing the panel repaints the bar so the Filters badge is right
  nowOpen = false;
}

// ---- menus -------------------------------------------------------------------------
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.parentNode.contains(e.target)) closeMenu(); }, true);

function dropdown(btn, options, cur, onPick, { right = false, note = '' } = {}) {
  btn.addEventListener('click', () => {
    if (openMenu) { closeMenu(); return; }
    const m = el('div', { class: 'menu' + (right ? ' right' : '') },
      options.map(([v, label]) => el('button', { class: v === cur ? 'sel' : '', onclick: () => { closeMenu(); onPick(v); } }, label)),
      note ? el('div', { class: 'note' }, note) : null);
    btn.parentNode.appendChild(m);
    openMenu = m;
  });
}

function targetName() {
  const t = st.targets.find((x) => x.device === st.target);
  return t ? t.name : '';
}

function openRoom() {
  if (window.EchoHub && typeof window.EchoHub.openDashboard === 'function') window.EchoHub.openDashboard();
  else toast('The Room view needs the Echo Hub app');
}

function renderBar() {
  closeMenu();
  bar.textContent = '';
  const nf = [st.type, st.f.genre, st.f.decade, st.f.rating, st.f.runtime, st.f.unwatched, st.f.recent].filter(Boolean).length;
  // One "⋯" menu holds the less-used controls (filters, view, wake words, open-app) so the top bar stays uncrowded.
  const viewBtn = el('button', { class: 'pill nocar opts' + (nf ? ' lit' : ''), 'aria-label': 'Filters, view and voice settings' },
    '⋯', nf ? el('em', {}, nf) : null);
  const viewDrop = el('div', { class: 'drop' }, viewBtn);
  viewBtn.addEventListener('click', () => {
    if (openMenu) { closeMenu(); return; }
    const v = st.view;
    const opt = (label, on, fn) => el('button', { class: on ? 'sel' : '', onclick: () => { fn(); saveView(); applyView(); closeMenu(); renderRow(true); } }, label);
    const tgt = castTarget();
    const m = el('div', { class: 'menu vmenu right' },
      el('button', { onclick: () => { closeMenu(); openFilters(); } }, nf ? `Filters (${nf})…` : 'Filters…'),
      el('div', { class: 'mh' }, 'Scroll'),
      opt('Sideways', v.dir === 'h', () => { v.dir = 'h'; }), opt('Up and down', v.dir === 'v', () => { v.dir = 'v'; }),
      el('div', { class: 'mh' }, 'Size'),
      ...SIZES.map(([k, l]) => opt(l, v.size === k, () => { v.size = k; })),
      el('div', { class: 'mh' }, 'Show'),
      opt('Posters', !v.logos, () => { v.logos = false; }), opt('Logos only', v.logos, () => { v.logos = true; }),
      el('div', { class: 'mh' }, 'Voice'),
      el('button', { onclick: () => { closeMenu(); openWakeSettings(); } }, 'Wake words…'),
      tgt && tgt.enabled ? el('div', { class: 'mh' }, 'TV') : null,
      // Wakes the picked TV and opens MyFlix on it (handy when its icon has vanished from the Fire TV home screen).
      tgt && tgt.enabled ? el('button', { onclick: () => { closeMenu(); ctl('launch'); } }, `Open app on ${tgt.name}`) : null);
    viewDrop.appendChild(m);
    openMenu = m;
  });

  const sortLabel = (SORTS.find((s) => s[0] === st.sort) || SORTS[1])[1];
  const sortBtn = el('button', { class: 'pill' }, el('b', {}, 'Sort'), el('span', {}, sortLabel));
  const sortDrop = el('div', { class: 'drop' }, sortBtn);
  dropdown(sortBtn, SORTS, st.sort, (v) => { st.sort = v; lsSet(LS.sort, v); renderBar(); renderRow(true); });

  const tn = targetName();
  const castBtn = el('button', { class: 'pill cast' + (st.targets.some((t) => t.enabled) ? '' : ' dis') },
    el('b', {}, 'Cast to'), el('span', {}, tn || (st.targets.length ? 'Pick a TV' : 'No TVs')));
  const castDrop = el('div', { class: 'drop', style: 'margin-left:auto' }, castBtn);
  dropdown(castBtn, st.targets.map((t) => [t.device, t.name]), st.target,
    (v) => { st.target = v; lsSet(LS.target, v); st.now = null; renderBar(); pollNow(); },
    { right: true, note: st.targets.some((t) => t.enabled) ? '' : 'Casting is not switched on yet' });

  // Library (this page) | Room (the Home Assistant living-room dashboard, opened by the app shell)
  const mode = el('div', { class: 'seg mode' },
    el('button', { class: 'on' }, 'Library'),
    el('button', { onclick: openRoom }, 'Room'));
  nowBtnEl = el('button', { class: 'pill nowbtn', style: 'display:none', onclick: openNow }, ico('play', 14), 'Now');
  const mic = el('button', { class: 'pill nocar mic' + (st.q ? ' lit' : '') + (wakeState.on ? ' wake' : ''), 'aria-label': 'Voice search',
    onclick: () => { if (st.q) { st.q = ''; renderBar(); renderRow(true); } else startVoice(); } },
    st.q ? el('span', {}, '“' + st.q + '”  ✕') : ico('mic', 18));
  const typeBtn = el('button', { class: 'pill nocar mic', 'aria-label': 'Type to search', onclick: openTypeSearch }, ico('search', 18));
  bar.append(...(st.q ? [mode, mic] : [mode, typeBtn, mic]), sortDrop, nowBtnEl, castDrop, viewDrop);
  updateNowBtn();
}

// ---- wake words: edit the phrases, switch listening and the chime ---------------------------------------------------
let closeWakeTest = () => {};
function openWakeSettings() {
  closeMenu(); closeDetail();
  const list = el('div', { class: 'wlist' });
  const input = el('input', { type: 'text', class: 'sinput', placeholder: 'Add a wake word, e.g. “hey jarvis”', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done' });
  const note = el('div', { class: 'hint' }, '');
  const tog = (label, key) => {
    const b = el('button', { class: 'chip' + (getWake()[key] ? ' on' : ''), onclick: async () => {
      try { await saveWake({ [key]: !getWake()[key] }); } catch { toast('Couldn’t save'); return; }
      if (key === 'chime' && getWake().chime) chime();
      paint(); renderBar();
    } }, label + (getWake()[key] ? ': On' : ': Off'));
    return b;
  };
  const toggles = el('div', { class: 'chips' });
  // sensitivity: 1 (picky) .. 5 (hears everything)
  const sensRow = el('div', { class: 'chips sens' });
  const paintSens = () => {
    sensRow.textContent = ''; sensRow.append(el('span', { class: 'fh' }, 'Sensitivity'));
    for (let i = 1; i <= 5; i++) sensRow.append(el('button', { class: 'chip' + (getSens() === i ? ' on' : ''), onclick: () => { setSens(i); paintSens(); } },
      i === 1 ? '1 Low' : i === 5 ? '5 High' : String(i)));
  };
  paintSens();
  // wake word check: says what the Echo heard and whether it counted, without doing anything
  const testBox = el('div', { class: 'testbox' }, 'Tap Test, then say your wake word.');
  let testing = false;
  const testBtn = el('button', { class: 'chip', onclick: () => {
    testing = !testing;
    testBtn.classList.toggle('on', testing);
    testBtn.textContent = testing ? 'Stop test' : 'Test wake word';
    if (testing) {
      testBox.textContent = 'Listening… say your wake word.';
      setTest((d) => {
        if (d.off) { testBox.textContent = 'Listening is off. Switch it on above.'; return; }
        const t = (d.text || '').trim();
        testBox.textContent = t ? `Heard “${t}” → ${d.wake ? 'MATCH ✓' + (d.command ? ' + “' + d.command + '”' : '') : 'no match'}` : 'Heard a sound but no words. Try louder, or raise sensitivity.';
        if (d.wake && getWake().chime) chime();
      });
    } else { setTest(null); testBox.textContent = 'Tap Test, then say your wake word.'; }
  } }, 'Test wake word');
  closeWakeTest = () => setTest(null);
  const paint = () => {
    toggles.textContent = ''; toggles.append(tog('Wake word listening', 'enabled'), tog('Chime', 'chime'));
    list.textContent = '';
    const words = getWake().words || [];
    if (!words.length) list.append(el('div', { class: 'hint' }, 'No wake words yet. Add one below.'));
    for (const w of words) list.append(el('div', { class: 'wrow' }, el('span', {}, '“' + w + '”'),
      el('button', { class: 'wdel', 'aria-label': 'Remove ' + w, onclick: async () => { try { await saveWake({ words: words.filter((x) => x !== w) }); } catch { toast('Couldn’t save'); } paint(); } }, '✕')));
    const lvl = () => (getWake().enabled && wakeState.on) ? `Mic level ${wakeLevel.peak.toFixed(0)} (needs > ${wakeLevel.thr.toFixed(0)}) · heard ${wakeLevel.segs} · checked ${wakeLevel.sent} · last: ${wakeLevel.heard || 'none'}` : '';
    clearInterval(note._t); if (lvl()) note._t = setInterval(() => { if (!note.isConnected) { clearInterval(note._t); return; } note.textContent = lvl(); }, 400);
    note.textContent = getWake().enabled ? (wakeState.on ? 'Listening. Say a wake word, then a title, or wait for the chime.' : 'On, but the microphone is not open yet.') : 'Listening is off.';
  };
  const add = async () => {
    const v = input.value.trim();
    if (v.length < 2) { input.focus(); return; }
    try { await saveWake({ words: [...(getWake().words || []), v] }); input.value = ''; } catch { toast('Couldn’t save'); }
    paint(); renderBar();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  paint();
  layer.textContent = '';
  layer.append(el('div', { class: 'dim top', onclick: (e) => { if (e.target.classList.contains('dim')) closeDetail(); } },
    el('div', { class: 'sbox wbox' }, el('h1', {}, 'Wake words'), toggles, sensRow, el('div', { class: 'chips' }, testBtn), testBox, list,
      el('div', { class: 'wadd' }, input, el('button', { class: 'btn play', onclick: add }, 'Add')), note,
      el('button', { class: 'x', 'aria-label': 'Close', onclick: closeDetail }, '✕'))));
}

// A wake word was heard (chime already played). With a command attached run it; otherwise open the listening card.
function onWake(command) {
  if (voice || layer.firstChild) return;
  const q = cleanQuery(command);
  if (q) { st.q = q; renderBar(); renderRow(true); if (!st.list.length) toast('No titles for “' + q + '”'); }
  else startVoice();
}

// ---- typed search: on-screen keyboard; Enter or Search runs it ----------------------------------------------------
function openTypeSearch() {
  closeMenu(); closeDetail();
  const input = el('input', { type: 'search', class: 'sinput', placeholder: 'Search titles', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' });
  const go = () => {
    const q = cleanQuery(input.value);
    if (!q) { input.focus(); return; }
    st.q = q; closeDetail(); renderBar(); renderRow(true);
    if (!st.list.length) toast('No titles for “' + q + '”');
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  layer.textContent = '';
  layer.append(el('div', { class: 'dim top', onclick: (e) => { if (e.target.classList.contains('dim')) closeDetail(); } },
    el('div', { class: 'sbox' }, input,
      el('button', { class: 'btn play', onclick: go }, ico('search', 18), 'Search'),
      el('button', { class: 'btn plain', 'aria-label': 'Speak instead', onclick: () => { closeDetail(); startVoice(); } }, ico('mic', 18)))));
  setTimeout(() => input.focus(), 50);
}

// ---- voice: tap, speak, (auto-stops on silence or after 7 s), whisper on the T14 turns it into text ----------------
let voice = null;
function closeVoice() {
  if (voice) { pauseWake(false); voice.dead = true; try { voice.rec && voice.rec.state !== 'inactive' && voice.rec.stop(); } catch {} voice.stream && voice.stream.getTracks().forEach((t) => t.stop()); try { voice.ac && voice.ac.close(); } catch {} clearTimeout(voice.cap); clearInterval(voice.vad); }
  voice = null; layer.textContent = '';
}
function voiceSheet(msg, sub, btn) {
  layer.textContent = '';
  layer.append(el('div', { class: 'dim', onclick: (e) => { if (e.target.classList.contains('dim')) closeVoice(); } },
    el('button', { class: 'vclose', 'aria-label': 'Close voice search', onclick: closeVoice }, '✕'),
    el('div', { class: 'vbox' }, el('div', { class: 'vmic' + (msg === 'Listening…' ? ' live' : '') }, ico('mic', 56)), el('div', { class: 'vmsg' }, msg), sub ? el('div', { class: 'vsub' }, sub) : null,
      btn ? el('button', { class: 'btn plain', onclick: btn[1] }, btn[0]) : el('button', { class: 'btn plain', onclick: closeVoice }, 'Cancel'))));
}
async function startVoice() {
  if (voice) return;
  closeMenu(); closeDetail();
  // Plain-http LAN (internet down) is not a secure context, so the browser hides the microphone.
  if (!window.isSecureContext) { toast('Voice needs the internet. Tap a title instead.'); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Voice needs the updated Echo Hub app'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('Microphone blocked: allow it for Echo Hub'); return; }
  pauseWake(true);
  const v = voice = { stream, chunks: [], t0: Date.now(), heard: false };
  const rec = v.rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) v.chunks.push(e.data); };
  rec.onstop = async () => {
    if (v.dead) return;
    const blob = new Blob(v.chunks, { type: rec.mimeType || 'audio/webm' });
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(v.vad); clearTimeout(v.cap);
    if (!v.heard || blob.size < 1500) { voiceSheet('Didn’t catch that', 'Tap the mic and try again', ['Try again', () => { closeVoice(); startVoice(); }]); return; }
    voiceSheet('Searching…', '');
    let text = '';
    try {
      const r = await fetch('/api/echo/stt', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type.split(';')[0], 'X-MyFlix-Profile': (store.get('profile') || {}).userId || '' }, body: blob });
      if (!r.ok) throw new Error('http ' + r.status);
      text = ((await r.json()).text || '').trim();
    } catch (e) { if (!v.dead) voiceSheet('Voice search is unavailable', 'Try again in a moment', ['Close', closeVoice]); return; }
    if (v.dead) return;
    const q = cleanQuery(text);
    if (!q) { voiceSheet('Didn’t catch that', text ? '“' + text + '”' : '', ['Try again', () => { closeVoice(); startVoice(); }]); return; }
    st.q = q; closeVoice(); renderBar(); renderRow(true);
    if (!st.list.length) toast('No titles for “' + q + '”');
  };
  // silence detection: stop ~1.2 s after speech ends
  try {
    const ac = v.ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize); let quiet = 0;
    v.vad = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      if (peak > 8) { v.heard = true; quiet = 0; } else quiet += 100;
      if ((v.heard && quiet >= 1200) || (!v.heard && Date.now() - v.t0 > 4500)) { try { rec.stop(); } catch {} clearInterval(v.vad); }
    }, 100);
  } catch { v.heard = true; }
  rec.start();
  v.cap = setTimeout(() => { try { rec.stop(); } catch {} }, 7000);
  voiceSheet('Listening…', 'Say a title, e.g. “Lion King”', ['Done', () => { try { rec.stop(); } catch {} }]);
}

// ---- row ---------------------------------------------------------------------------
// Always the show / movie poster, never an episode still (Continue Watching holds episodes).
function posterUrl(it, w) {
  if (it.type === 'Episode') {
    const t = it.seriesImg && it.seriesImg.primary;
    return t && it.seriesId ? `/img/${encodeURIComponent(it.seriesId)}/Primary?tag=${encodeURIComponent(t)}&w=${w}` : null;
  }
  return imgUrl(it, 'Primary', w);
}

function card(it) {
  const title = it.type === 'Episode' ? (it.seriesName || it.name) : it.name;
  const sub = it.type === 'Episode' ? `S${it.season}:E${it.episode}` : [it.year, it.type === 'Series' && it.seasons ? it.seasons + (it.seasons === 1 ? ' Season' : ' Seasons') : ''].filter(Boolean).join(' · ');
  if (st.view.logos) return logoCard(it, title);
  const src = posterUrl(it, 320);
  const art = el('div', { class: 'art' });
  if (src) {
    const img = el('img', { src, alt: '', decoding: 'async', loading: 'lazy' });
    img.addEventListener('error', () => { img.remove(); art.append(el('div', { class: 'ph' }, title)); });
    art.append(img);
  } else art.append(el('div', { class: 'ph' }, title));
  const pct = it.playedPct;
  if (pct && pct > 0 && pct < 100) art.append(el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })));
  return el('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => openDetail(it) },
    art, el('div', { class: 't' }, title), el('div', { class: 's' }, sub));
}

// Logos-only view: the title's transparent logo on a dark tile, its name in plain text if it has none.
function logoCard(it, title) {
  const src = imgUrl(it, 'Logo', 320);
  const art = el('div', { class: 'art lg' });
  const txt = () => art.append(el('div', { class: 'ph' }, title));
  if (src) {
    const img = el('img', { src, alt: title, decoding: 'async', loading: 'lazy' });
    img.addEventListener('error', () => { img.remove(); txt(); });
    art.append(img);
  } else txt();
  const pct = it.playedPct;
  if (pct && pct > 0 && pct < 100) art.append(el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` })));
  return el('div', { class: 'card lgc', role: 'button', tabindex: '0', 'aria-label': title, onclick: () => openDetail(it) }, art);
}

function more() {
  const end = Math.min(st.list.length, st.shown + PAGE);
  for (let i = st.shown; i < end; i++) row.append(card(st.list[i]));
  st.shown = end;
}

function renderRow(reset) {
  if (reset) { row.scrollLeft = 0; row.scrollTop = 0; }
  row.textContent = '';
  row.style.gap = '';
  st.list = currentList();
  st.shown = 0;
  if (!st.list.length) {
    row.append(el('div', { class: 'msg' }, st.q ? `No titles for “${st.q}”.` : st.sort === 'continue' && !filtersOn() ? 'Nothing to continue yet.' : filtersOn() ? 'No titles match these filters.' : 'No titles.'));
    return;
  }
  more();
  fillView();
}
// Vertical grids show many cards at once: keep adding batches until the view is full (or the list ends).
function fillView() {
  const v = st.view.dir === 'v';
  while (st.shown < st.list.length && (v ? row.scrollHeight <= row.clientHeight + 400 : row.scrollWidth <= row.clientWidth + 600)) more();
}
row.addEventListener('scroll', () => {
  if (st.shown >= st.list.length) return;
  if (st.view.dir === 'v' ? row.scrollTop + row.clientHeight > row.scrollHeight - 400 : row.scrollLeft + row.clientWidth > row.scrollWidth - 600) more();
}, { passive: true });

// ---- now playing: what the target TV is on right now, with pause / play / skip / stop ---------
let nowBtnEl = null, nowOpen = false, nowSheetTimer = null, nowTick = 0;

function castTarget() { return st.targets.find((x) => x.device === st.target); }
function estPos() {
  const n = st.now;
  return n ? Math.min(n.runtimeMs || Infinity, n.positionMs + (n.paused ? 0 : Date.now() - st.nowAt)) : 0;
}
function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

function updateNowBtn() {
  if (!nowBtnEl) return;
  nowBtnEl.style.display = st.now ? '' : 'none';
  bar.classList.toggle('hasnow', !!st.now);   // make room: drop the Sort / Cast-to prefixes while the Now pill shows
  if (st.now) nowBtnEl.replaceChildren(ico(st.now.paused ? 'pause' : 'play', 14), 'Now');
}

async function pollNow() {
  const t = castTarget();
  if (!t || !t.enabled || document.hidden) return;
  const n = await nowPlaying(st.target);
  st.now = n; st.nowAt = Date.now();
  updateNowBtn();
  if (nowOpen) { if (n) renderNow(); else { closeDetail(); toast('Playback ended'); } }
}

async function ctl(action) {
  const t = castTarget();
  if (!t) return;
  try {
    await post('/api/cast/control', { device: t.device, action });
  } catch (e) {
    toast(e.code === 'tv_unreachable' ? `Can’t reach ${t.name} (is it on?)` : e.code === 'rate_limited' ? 'Slow down a little' : `Control failed${e.code ? ': ' + e.code : ''}`);
    return;
  }
  if (action === 'launch') { toast(`Opening MyFlix on ${t.name}`); return; }
  if (action === 'stop') { st.now = null; updateNowBtn(); closeDetail(); toast(`Stopped on ${t.name}`); return; }
  if (st.now) {   // optimistic: freeze or resume the clock now, the poll corrects it
    st.now.positionMs = estPos(); st.nowAt = Date.now();
    if (action === 'pause') st.now.paused = true;
    if (action === 'play') st.now.paused = false;
    updateNowBtn(); if (nowOpen) renderNow();
  }
  setTimeout(pollNow, 1500);
}

// The episode after the one on screen (next in its season, else the first of the next season); null on the last one.
const nextCache = new Map();   // playing item id -> episode | null
async function nextEpisodeOf(n) {
  if (!n.seriesId) return null;
  if (nextCache.has(n.itemId)) return nextCache.get(n.itemId);
  let nxt = null;
  try {
    const d = await getItem(n.seriesId);
    const seasons = (d.seasons || []).filter((x) => x && x.id);
    const si = seasons.findIndex((x) => x.index === n.season);
    if (si >= 0) {
      const list = (await getSeason(n.seriesId, seasons[si].id)) || [];
      const i = list.findIndex((e) => e.id === n.itemId);
      nxt = i >= 0 ? list[i + 1] || null : null;
      if (!nxt && seasons[si + 1]) nxt = ((await getSeason(n.seriesId, seasons[si + 1].id)) || [])[0] || null;
    }
  } catch { return null; }   // a blip is not cached: try again on the next refresh
  nextCache.set(n.itemId, nxt);
  return nxt;
}

async function playNext(ep, btn) {
  const t = castTarget();
  if (!t) return;
  btn.disabled = true;
  try {
    await post('/api/cast', { device: t.device, itemId: ep.id, force: true });   // replacing the current episode is the point
    toast(`Playing S${ep.season}:E${ep.episode} on ${t.name}`);
    setTimeout(pollNow, 3500);
  } catch (e) {
    toast(e.code === 'tv_unreachable' ? `Can’t reach ${t.name} (is it on?)` : e.code === 'rate_limited' ? 'Slow down a little' : `Couldn’t start the next episode${e.code ? ': ' + e.code : ''}`);
  } finally { btn.disabled = false; }
}

function renderNow() {
  const n = st.now, sheet = layer.querySelector('.sheet.np');
  if (!sheet || !n) return;
  const t = castTarget();
  const src = n.img && n.img.tag ? `/img/${encodeURIComponent(n.img.id)}/Primary?tag=${encodeURIComponent(n.img.tag)}&w=480` : null;
  const title = n.seriesName || n.name;
  const ep = n.seriesName ? `S${n.season}:E${n.episode} · ${n.name}` : '';
  const fill = el('i', { style: 'width:0%' }), time = el('span', {}, '');
  const paint = () => {
    const pos = estPos();
    time.textContent = `${fmtTime(pos)} / ${n.runtimeMs ? fmtTime(n.runtimeMs) : '--:--'}`;
    fill.style.width = (n.runtimeMs ? Math.min(100, pos / n.runtimeMs * 100) : 0) + '%';
  };
  paint();
  sheet.textContent = '';
  sheet.append(
    el('div', { class: 'poster' }, src ? el('img', { src, alt: '', decoding: 'async' }) : null),
    el('div', { class: 'info' },
      el('div', { class: 'meta' }, el('span', { class: 'pl' }, n.paused ? 'PAUSED' : 'NOW PLAYING'), el('span', {}, 'on ' + (t ? t.name : 'TV'))),
      el('h1', {}, title), ep ? el('div', { class: 'meta' }, ep) : null,
      el('div', { class: 'track' }, el('div', { class: 'tbar' }, fill), time),
      el('div', { class: 'ctl' },
        el('button', { class: 'cb', 'aria-label': 'Back 10 seconds', onclick: () => ctl('rewind') }, ico('back10', 48)),
        el('button', { class: 'cb big', 'aria-label': n.paused ? 'Play' : 'Pause', onclick: () => ctl(n.paused ? 'play' : 'pause') }, ico(n.paused ? 'play' : 'pause', 54)),
        el('button', { class: 'cb', 'aria-label': 'Forward 10 seconds', onclick: () => ctl('forward') }, ico('fwd10', 48))),
      el('button', { class: 'cb stop', 'aria-label': 'Stop', onclick: () => ctl('stop') }, 'Stop')),
    el('button', { class: 'x', 'aria-label': 'Close', onclick: closeDetail }, '✕'));
  sheet._paint = paint;
  if (n.seriesId) {   // Next episode: bottom left, mirror of Stop; appears once the next one is known
    const known = nextCache.get(n.itemId);
    const attach = (ep) => {
      if (!ep || !sheet.isConnected) return;
      const nb = el('button', { class: 'cb nextep', 'aria-label': `Next episode, S${ep.season}:E${ep.episode}`, onclick: () => playNext(ep, nb) }, ico('next', 16), 'Next episode');
      sheet.querySelector('.info').append(nb);
    };
    if (known !== undefined) attach(known);
    else nextEpisodeOf(n).then((ep) => { if (nowOpen && st.now && st.now.itemId === n.itemId) { if (ep) attach(ep); } });
  }
}

function openNow() {
  if (!st.now) return;
  closeDetail();
  nowOpen = true; nowTick = 0;
  layer.append(el('div', { class: 'dim', onclick: (e) => { if (e.target.classList.contains('dim')) closeDetail(); } }, el('div', { class: 'sheet np' })));
  renderNow();
  nowSheetTimer = setInterval(() => {   // clock ticks locally every second; a real poll every 3s
    const sh = layer.querySelector('.sheet.np');
    if (sh && sh._paint) sh._paint();
    if (++nowTick % 3 === 0) pollNow();
  }, 1000);
}
setInterval(pollNow, 6000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNow(); });

// ---- detail + cast -----------------------------------------------------------------
function closeDetail() { closeWakeTest(); if (voice) { closeVoice(); return; } const wasF = !!layer.querySelector('.fsheet'); layer.textContent = ''; nowOpen = false; clearInterval(nowSheetTimer); if (wasF) renderBar(); }

// After a cast, poll the TV until it reports playback, then swap the detail sheet for Now Playing.
let goNowTok = 0;
async function goNowWhenPlaying(device, sheetEl, prevId, forced) {
  const tok = ++goNowTok;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, i ? 2000 : 1500));
    if (tok !== goNowTok || st.target !== device || (sheetEl && !sheetEl.isConnected)) return;   // newer cast, TV switched, or the user closed/changed the sheet
    const n = await nowPlaying(device);
    if (tok !== goNowTok || (sheetEl && !sheetEl.isConnected)) return;
    if (n && !(forced && n.itemId === prevId)) {   // a forced cast: ignore the old item until the TV switches
      st.now = n; st.nowAt = Date.now(); updateNowBtn(); if (!nowOpen) openNow(); return;
    }
  }
}

let forceNext = null;   // item id the user already confirmed "cast anyway" for

async function cast(it, btn) {
  const t = st.targets.find((x) => x.device === st.target);
  if (!t) { toast('Pick a TV first (top right)'); return; }
  if (!t.enabled) { toast('Casting is not switched on yet'); return; }
  if (btn) btn.disabled = true;
  try {
    const forced = forceNext === it.id, prevId = st.now && st.now.itemId, sheet = layer.querySelector('.sheet');
    await post('/api/cast', { device: t.device, itemId: it.id, force: forced });
    forceNext = null;
    if (btn) btn.textContent = `▶ Cast to ${t.name}`;
    toast(`Sent to ${t.name}`);
    goNowWhenPlaying(t.device, sheet, prevId, forced);
  } catch (e) {
    if (e.code === 'tv_busy') {
      forceNext = it.id;
      if (btn) btn.textContent = `Cast anyway — ${t.name} is playing`;
      toast(`${t.name} is playing${e.data && e.data.playing ? ': ' + e.data.playing : ''}`);
    } else if (e.code === 'tv_unreachable') toast(`Can’t reach ${t.name} (is it on?)`);
    else if (e.code === 'rate_limited') toast('Slow down a little');
    else if (e.code === 'cast_disabled' || e.code === 'cast_unavailable') toast('Casting is not set up yet');
    else toast(`Cast failed${e.code ? ': ' + e.code : ''}`);
  } finally { if (btn) btn.disabled = false; }
}

async function post(path, body) {
  const p = store.get('profile');
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(p && p.userId ? { 'X-MyFlix-Profile': p.userId } : {}) },
    body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error((data && data.error) || 'HTTP ' + res.status); e.code = data && data.error; e.data = data; throw e; }
  return data;
}

// Series sheet: season menu + tappable episode list. A tap casts that episode. The big button casts the next one up, or,
// when the target TV is playing this show right now, the episode after the one on screen.
function epRow(ep, playingId, onPick) {
  const rt = ep.runtimeMin ? `${ep.runtimeMin}m` : '';
  const pct = ep.playedPct;
  const now = ep.id === playingId;
  const row = el('div', { class: 'ep' + (ep.played ? ' done' : '') + (now ? ' now' : ''), role: 'button', tabindex: '0',
      onclick: () => onPick(ep) },
    el('span', { class: 'n' }, ep.episode != null ? 'E' + ep.episode : ''),
    el('span', { class: 'nm' }, ep.name || ''),
    now ? el('span', { class: 'pl' }, '▶ Playing') : ep.played ? el('span', { class: 'ck' }, '✓') : null,
    el('span', { class: 'rt' }, rt));
  if (pct && pct > 0 && pct < 100) row.append(el('i', { class: 'pg', style: `width:${pct}%` }));
  return row;
}

async function nowPlaying(device) {
  if (!device) return null;
  try {
    const p = store.get('profile');
    const r = await fetch('/api/cast/now?device=' + encodeURIComponent(device), { credentials: 'same-origin', headers: { 'X-MyFlix-Profile': (p && p.userId) || '' } });
    return r.ok ? (await r.json()).playing : null;
  } catch { return null; }
}

async function fillSeries(it, info, castBtn) {
  const eps = el('div', { class: 'eps' }, el('div', { class: 'hint' }, 'Loading episodes…'));
  const bar = el('div', { class: 'drop sbar' });
  info.insertBefore(bar, info.querySelector('.acts'));
  info.insertBefore(eps, info.querySelector('.acts'));
  let d;
  try { d = await getItem(it.id); } catch { eps.textContent = 'Couldn’t load episodes.'; return; }
  const seasons = (d.seasons || []).filter((x) => x && x.id);
  if (!seasons.length) { eps.textContent = 'No episodes.'; return; }

  const np = await nowPlaying(st.target);
  const playing = np && np.seriesId === it.id ? np : null;   // this show is on the TV right now
  const tag = (e) => `S${e.season}:E${e.episode}`;
  let target = d.nextUp || it;

  function setButton(label, ep) {
    target = ep || target;
    castBtn.firstChild.textContent = label;
  }
  if (playing) {
    setButton(`▶ After S${playing.season}:E${playing.episode}…`, null);   // refined once its season is loaded
  } else if (d.nextUp) {
    setButton(`${d.nextUp.playedPct > 0 ? '▶ Resume' : '▶ Next up'} ${tag(d.nextUp)}`, d.nextUp);
  }
  castBtn.onclick = () => cast(target, castBtn);   // a busy TV arms "cast anyway" for this title; the next tap sends it

  // The episode after the one playing: next in its season, else the first of the next season.
  async function resolveAfter(list) {
    const i = list.findIndex((e) => e.id === playing.itemId);
    let nxt = i >= 0 ? list[i + 1] : null;
    if (!nxt) {
      const si = seasons.findIndex((x) => x.index === playing.season);
      const ns = si >= 0 ? seasons[si + 1] : null;
      if (ns) { try { nxt = (await getSeason(it.id, ns.id) || [])[0]; } catch {} }
    }
    if (nxt) setButton(`▶ Next ${tag(nxt)}`, nxt);
    else { castBtn.firstChild.textContent = 'Last episode'; castBtn.disabled = true; }
  }

  // Episode detail: opens over the sheet's right column; casting happens from here, not from the list.
  function showEp(ep) {
    forceNext = null;
    const tg = st.targets.find((x) => x.device === st.target);
    const thumb = imgUrl(ep, 'Primary', 320) || imgUrl(ep, 'Thumb', 320);   // an episode still is its Primary image
    const nowHere = playing && playing.itemId === ep.id;
    const label = nowHere ? (tg ? `▶ Cast again to ${tg.name}` : '▶ Cast again')
      : ep.playedPct > 0 && ep.playedPct < 100 ? (tg ? `▶ Resume on ${tg.name}` : '▶ Resume')
      : (tg ? `▶ Cast to ${tg.name}` : '▶ Cast');
    const btn = el('button', { class: 'btn play' }, label);
    btn.addEventListener('click', () => cast(ep, btn));
    const rt = ep.runtimeMin ? (Math.floor(ep.runtimeMin / 60) ? `${Math.floor(ep.runtimeMin / 60)}h ${ep.runtimeMin % 60}m` : `${ep.runtimeMin}m`) : '';
    const view = el('div', { class: 'epd' },
      el('button', { class: 'back', onclick: () => view.remove() }, '‹ Episodes'),
      el('div', { class: 'epd-top' },
        thumb ? el('img', { class: 'thumb', src: thumb, alt: '', decoding: 'async', onerror: (e) => e.target.remove() }) : null,
        el('div', { class: 'epd-head' },
          el('h2', {}, ep.name || ''),
          el('div', { class: 'meta' },
            el('span', {}, `S${ep.season}:E${ep.episode}`), rt ? el('span', {}, rt) : null,
            nowHere ? el('span', { class: 'pl' }, '▶ Playing now') : ep.played ? el('span', { class: 'ck' }, '✓ Watched') : null,
            ep.playedPct > 0 && ep.playedPct < 100 ? el('span', {}, `${Math.round(ep.playedPct)}% watched`) : null))),
      el('p', {}, ep.overview || 'No description.'),
      el('div', { class: 'acts' }, btn),
      tg && !tg.enabled ? el('div', { class: 'hint' }, 'Casting is not switched on yet') : null);
    info.append(view);
  }

  let cur = (playing && seasons.find((x) => x.index === playing.season))
    || seasons.find((x) => d.nextUp && x.index === d.nextUp.season) || seasons.find((x) => x.unplayedCount > 0) || seasons[0];
  async function show(season) {
    cur = season;
    eps.textContent = '';
    eps.append(el('div', { class: 'hint' }, 'Loading…'));
    let list;
    try { list = await getSeason(it.id, season.id); } catch { eps.textContent = 'Couldn’t load this season.'; return; }
    list = list || [];
    eps.textContent = '';
    for (const ep of list) eps.append(epRow(ep, playing && playing.itemId, showEp));
    const focus = eps.querySelector('.ep.now') || eps.querySelector('.ep:not(.done)');
    if (focus) eps.scrollTop = Math.max(0, focus.offsetTop - 4);
    if (playing && season.index === playing.season) resolveAfter(list);
    renderSeasonBtn();
  }
  function renderSeasonBtn() {
    bar.textContent = '';
    const b = el('button', { class: 'pill' }, el('span', {}, cur.name || ('Season ' + cur.index)));
    bar.append(b);
    dropdown(b, seasons.map((x) => [x.id, x.name || ('Season ' + x.index)]), cur.id, (id) => show(seasons.find((x) => x.id === id)));
  }
  renderSeasonBtn();
  show(cur);
}

function openDetail(it) {
  forceNext = null;
  const title = it.type === 'Episode' ? `${it.seriesName || ''}` : it.name;
  const ep = it.type === 'Episode' ? `S${it.season}:E${it.episode} · ${it.name}` : '';
  const src = imgUrl(it, 'Primary', 480);
  const t = st.targets.find((x) => x.device === st.target);
  const castBtn = el('button', { class: 'btn play' }, t ? `▶ Cast to ${t.name}` : '▶ Cast');
  if (it.type !== 'Series') castBtn.addEventListener('click', () => cast(it, castBtn));
  const meta = el('div', { class: 'meta' },
    it.score ? el('span', { class: 'sc' }, '★ ' + it.score) : null,
    it.year ? el('span', {}, it.year) : null,
    it.rating ? el('span', { class: 'rt' }, it.rating) : null,
    it.runtimeMin ? el('span', {}, Math.floor(it.runtimeMin / 60) ? `${Math.floor(it.runtimeMin / 60)}h ${it.runtimeMin % 60}m` : `${it.runtimeMin}m`) : null,
    it.genres && it.genres.length ? el('span', {}, it.genres.slice(0, 3).join(' • ')) : null);
  const sheet = el('div', { class: 'sheet' },
    el('div', { class: 'poster' }, src ? el('img', { src, alt: '', decoding: 'async' }) : null),
    el('div', { class: 'info' },
      el('h1', {}, title), ep ? el('div', { class: 'meta' }, ep) : null, meta,
      it.type === 'Series' ? null : el('p', {}, it.overview || ''),
      el('div', { class: 'acts' }, castBtn),
      t && !t.enabled ? el('div', { class: 'hint' }, 'Casting is not switched on yet') : null),
    el('button', { class: 'x', 'aria-label': 'Close', onclick: closeDetail }, '✕'));
  const infoEl = sheet.querySelector('.info');
  if (it.type === 'Series') fillSeries(it, infoEl, castBtn);
  layer.textContent = '';
  layer.append(el('div', { class: 'dim', onclick: (e) => { if (e.target.classList.contains('dim')) closeDetail(); } }, sheet));
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

// ---- boot --------------------------------------------------------------------------
function message(text, btnLabel, fn) {
  row.textContent = '';
  row.append(el('div', { class: 'msg' }, text, btnLabel ? el('div', {}, el('button', { onclick: fn }, btnLabel)) : null));
}

function pickProfile(me) {
  bar.textContent = '';
  bar.append(el('div', { class: 'word' }, 'MYFLIX'));
  row.textContent = '';
  row.style.gap = '16px';
  for (const p of me.profiles || []) {
    row.append(el('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => { store.set('profile', { userId: p.userId, name: p.name, imageUrl: p.imageUrl || null }); location.reload(); } },
      el('div', { class: 'art', style: 'height:150px' }, p.imageUrl ? el('img', { src: p.imageUrl, alt: '' }) : el('div', { class: 'ph' }, p.name)),
      el('div', { class: 't' }, p.name)));
  }
  if (!(me.profiles || []).length) message('No profiles linked. Link one in MyFlix first.');
}

async function loadTargets() {
  try {
    const r = await fetch('/api/cast/targets', { credentials: 'same-origin', headers: { 'X-MyFlix-Profile': (store.get('profile') || {}).userId || '' } });
    st.targets = r.ok ? await r.json() : [];
  } catch { st.targets = []; }
  if (!st.targets.some((t) => t.device === st.target)) st.target = st.targets[0] ? st.targets[0].device : '';
}

async function boot() {
  message('Loading…');
  let me;
  try { me = await getMe(); } catch (e) { message('Can’t reach MyFlix.', 'Retry', () => location.reload()); return; }
  let prof = store.get('profile');
  if (!prof || !(me.profiles || []).some((p) => p.userId === prof.userId)) {
    if ((me.profiles || []).length === 1) { store.set('profile', { userId: me.profiles[0].userId, name: me.profiles[0].name, imageUrl: me.profiles[0].imageUrl || null }); location.reload(); return; }
    pickProfile(me); return;
  }
  try {
    const [index, home] = await Promise.all([getIndex(), getHome().catch(() => null), loadTargets()]);
    st.items = Array.isArray(index) ? index : [];
    st.byId = new Map(st.items.map((x) => [x.id, x]));
    st.home = home;
  } catch (e) { message('Couldn’t load titles.', 'Retry', () => location.reload()); return; }
  if (st.sort === 'continue' && !continueList().length) st.sort = 'added';
  applyView();
  renderBar();
  renderRow(true);
  pollNow();
  initWake(onWake, () => ({ 'X-MyFlix-Profile': (store.get('profile') || {}).userId || '' })).then(() => renderBar());
  // The launcher stays up for days; refresh the library once an hour.
  setInterval(async () => {
    try {
      const [index, home] = await Promise.all([getIndex({ refresh: true }), getHome().catch(() => null)]);
      st.items = Array.isArray(index) ? index : st.items; st.home = home || st.home;
      st.byId = new Map(st.items.map((x) => [x.id, x]));
      if (!layer.firstChild) { const kl = row.scrollLeft, kt = row.scrollTop; renderRow(false); row.scrollLeft = kl; row.scrollTop = kt; }
    } catch {}
  }, 60 * 60 * 1000);
}
boot();

// Doorbell: Home Assistant tells the server when the button is pressed; the app shell then shows the camera (silently).
// Polled even while the Room view covers this page, so a press while you are on the Lights tab still jumps to the camera.
let alertSeq = null;
async function pollAlert() {
  try {
    const r = await fetch('/api/echo/alert', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const a = await r.json();
    if (alertSeq === null) { alertSeq = a.seq; return; }   // first look: just learn the current number, don't replay an old alert
    if (a.seq === alertSeq) return;
    alertSeq = a.seq;
    if (a.kind === 'doorbell' && a.ageSec != null && a.ageSec < 30) {
      closeDetail();
      if (window.EchoHub && typeof window.EchoHub.showDoorbell === 'function') window.EchoHub.showDoorbell();
    }
  } catch {}
}
setInterval(pollAlert, 3000);
pollAlert();

// Self-update: the launcher stays up for days, so pick up new deploys without anyone reopening the app. /echo is served
// fresh from the origin; when its asset version (?v=N) changes, reload once nothing is open on screen.
const myVer = (document.querySelector('script[src*="echo.js"]') || {}).src?.match(/[?&]v=(\d+)/)?.[1];
setInterval(async () => {
  if (!myVer || document.hidden || layer.firstChild || openMenu) return;
  try {
    const html = await (await fetch('/echo', { credentials: 'same-origin', cache: 'no-store' })).text();
    const v = html.match(/echo\.js\?v=(\d+)/);
    if (v && v[1] !== myVer) location.reload();
  } catch {}
}, 2 * 60 * 1000);
