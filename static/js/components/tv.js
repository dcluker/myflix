// Spatial (arrow-key / D-pad) navigation, Back handling and focus memory.
//
//  - Arrow keys move focus to the geometrically nearest focusable in that direction inside the
//    active layer (#modal-root when a modal is open, otherwise #nav + #view).
//  - Up/Down between rows remembers each row's last-focused card.
//  - Enter / OK (13, 23) activates non-native focusables; Back (Escape, 4, GoBack, BrowserBack,
//    Backspace on TV) closes the modal, else history.back() on TV.
//  - Media Play/Pause on a focused card opens /play/<id>.
//  - Desktop: arrows only take over once focus is already inside a layer, so the page still
//    scrolls with the keyboard. Text inputs keep their arrows (except Up/Down out of the nav
//    search box, and everything on TV where the caret is at the edge).
//
// Hook for row implementations: before scrolling a focused element into view this module
// dispatches a cancelable, bubbling `tv:reveal` event on it. preventDefault() it to take over.
import * as store from '../store.js';
import { closeDetail, closeSuggest } from './detail.js';
import { closeRequest } from './request.js';
import { isTV } from '../util.js';

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
const TEXT_TYPES = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number']);
const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const CODE_DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
const ROW_SEL = '.row, [data-row]';
const SIDE_LINK = '.row-more';
const SKIP = '[data-tv-skip]';   // never a spatial-nav stop (Tab still reaches it)

let started = false;
const rowMem = new WeakMap();   // row element -> last focused element inside it
const viewMem = new Map();      // hash -> {id} of the card that had focus when leaving
let lastClickAt = -1e9;
let lastPopAt = -1e9;
let lastBackAt = -1e9;
let curHash = null;
let observer = null;
let observerTimer = 0;

// ---- predicates --------------------------------------------------------------------------
function isTextInput(t) {
  if (!t || !t.tagName) return false;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.isContentEditable) return true;
  if (t.tagName === 'INPUT') return TEXT_TYPES.has((t.getAttribute('type') || 'text').toLowerCase());
  return false;
}

function modalRoot() {
  const m = document.getElementById('modal-root');
  return m && m.firstElementChild ? m : null;
}

function layerRoots() {
  const m = modalRoot();
  if (m) return [m];
  return [document.getElementById('nav'), document.getElementById('view')].filter(Boolean);
}

function usable(n) {
  if (!n.isConnected || n.closest('[inert]')) return false;
  if (typeof n.checkVisibility === 'function') {
    try { return n.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }); } catch {}
  }
  const cs = getComputedStyle(n);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function rowOf(n) { return n.closest(ROW_SEL); }

// ---- geometry ---------------------------------------------------------------------------------
function rectOf(n) {
  const r = n.getBoundingClientRect();
  return { el: n, l: r.left, t: r.top, r: r.right, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width, h: r.height };
}

function collect(roots) {
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    for (const n of root.querySelectorAll(FOCUSABLE)) {
      if (n.tabIndex < 0 || n.disabled || n.hidden) continue;
      if (n.tagName === 'INPUT' && n.type === 'hidden') continue;
      const k = rectOf(n);
      if (k.w < 1 || k.h < 1) continue;
      out.push(k);
    }
  }
  return out;
}

// Lower is better; Infinity = not a candidate in this direction.
function score(c, k, dir) {
  let a;
  switch (dir) {
    case 'right': if (!(k.cx > c.cx + 1 && k.l > c.cx)) return Infinity; a = Math.max(0, k.l - c.r); break;
    case 'left': if (!(k.cx < c.cx - 1 && k.r < c.cx)) return Infinity; a = Math.max(0, c.l - k.r); break;
    case 'down': if (!(k.cy > c.cy + 1 && k.t > c.cy)) return Infinity; a = Math.max(0, k.t - c.b); break;
    default: if (!(k.cy < c.cy - 1 && k.b < c.cy)) return Infinity; a = Math.max(0, c.t - k.b);
  }
  if (dir === 'left' || dir === 'right') {
    // Horizontal moves stay on the same visual line.
    const ov = Math.min(c.b, k.b) - Math.max(c.t, k.t);
    if (ov < Math.min(c.h, k.h) * 0.3) return Infinity;
    return a + Math.abs(k.cy - c.cy) * 2;
  }
  const ov = Math.min(c.r, k.r) - Math.max(c.l, k.l);
  const off = Math.abs(k.cx - c.cx);
  return a + (ov > 0 ? off * 0.6 : off * 1.5 + (-ov) * 0.5);
}

function firstCardOf(row) {
  const track = row.querySelector('.row-track');
  if (!track) return null;
  for (const n of track.querySelectorAll(FOCUSABLE)) {
    if (n.tabIndex < 0 || n.disabled || n.hidden || n.matches(SKIP)) continue;
    if (usable(n)) return n;
  }
  return null;
}

// A-Z rail <-> grid: the rail letters are short, so "the same visual line" rarely overlaps a card row. Left from a letter lands on the
// card nearest its height (right-most column first); Right from the last column lands on the letter nearest the card's height.
function pick(cur, dir) {
  if (dir === 'left' && cur.classList && cur.classList.contains('arail-btn')) {
    const c = rectOf(cur), vh = window.innerHeight;
    let best = null, bs = Infinity;
    for (const k of collect(layerRoots())) {
      if (!k.el.closest('.bgrid') || k.r > c.l + 1 || k.b < 0 || k.t > vh || !usable(k.el)) continue;
      const sc = Math.abs(k.cy - c.cy) * 2 + (c.l - k.r) * 0.2;
      if (sc < bs) { bs = sc; best = k.el; }
    }
    if (best) return best;
  }
  const hit = pickBase(cur, dir);
  if (!hit && dir === 'right' && cur.closest && cur.closest('.bgrid')) {
    const c = rectOf(cur);
    let best = null, bd = Infinity;
    for (const b of document.querySelectorAll('.arail-btn')) {
      if (b.disabled || b.tabIndex < 0 || !usable(b)) continue;
      const k = rectOf(b), d = Math.abs(k.cy - c.cy);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) return best;
  }
  return hit;
}

function pickBase(cur, dir) {
  const cands = collect(layerRoots());
  const c = rectOf(cur);
  const curRow = rowOf(cur);
  let scored = [];
  for (const k of cands) {
    if (k.el === cur || cur.contains(k.el) || k.el.contains(cur)) continue;
    // Row header links ("Explore All") are only reached by pressing Up from a card in that row,
    // so Down/Left/Right never stop on them between rows.
    if (k.el.matches(SKIP)) continue;
    if (k.el.matches(SIDE_LINK) && !(dir === 'up' && curRow && rowOf(k.el) === curRow)) continue;
    const s = score(c, k, dir);
    if (s !== Infinity) scored.push({ s, k });
  }
  if (!scored.length) return null;
  // Going up, content above the fold beats the top nav (a hero scrolled off screen is still the
  // next stop); the nav is only a fallback.
  if (dir === 'up' && !cur.closest('#nav')) {
    const inView = scored.filter((e) => !e.k.el.closest('#nav'));
    if (inView.length) scored = inView;
  }
  // Same inside the detail modal: the close button is pinned top-right, so after scrolling down it is
  // the nearest thing above. Going up should walk back to Play first; close is only the fallback.
  if (dir === 'up' && cur.closest('.dm-layer') && !cur.matches('.dm-close')) {
    const inBody = scored.filter((e) => !e.k.el.matches('.dm-close'));
    if (inBody.length) scored = inBody;
  }
  scored.sort((x, y) => x.s - y.s);
  // The season select sits right-aligned above a full-width episode list, so geometry alone makes Down from the
  // synopsis/buttons overshoot it into the episodes. If nothing sits between here and the select, stop on it.
  if (dir === 'down' && cur.closest('.dm-layer') && !cur.closest('.dm-eps')) {
    const sel = scored.find((e) => e.k.el.matches('.dm-select') && usable(e.k.el));
    if (sel && scored.every((e) => e === sel || e.k.t >= sel.k.t - 4)) scored = [sel, ...scored.filter((e) => e !== sel)];
  }

  let best = null;
  for (const e of scored) { if (usable(e.k.el)) { best = e.k.el; break; } }
  if (!best) return null;

  // Up/Down: land back on the column this row was last left from.
  if (dir === 'up' || dir === 'down') {
    const row = rowOf(best);
    if (row && row !== rowOf(cur)) {
      const mem = rowMem.get(row);
      if (mem && mem !== cur && mem.isConnected && usable(mem) && scored.some((e) => e.k.el === mem)) best = mem;
    }
    // Halfway along the row you are leaving? Then start the next row at its first card, not
    // wherever the columns happen to line up (or wherever that row was last left).
    const toRow = rowOf(best);
    const fromTrack = curRow && toRow && toRow !== curRow ? curRow.querySelector('.row-track') : null;
    if (fromTrack && fromTrack.scrollLeft > 8) {
      const first = firstCardOf(toRow);
      if (first) best = first;
    }
  }
  return best;
}

// ---- focus + scrolling -------------------------------------------------------------------------
function navBottom() {
  const nav = document.getElementById('nav');
  return nav ? nav.getBoundingClientRect().bottom : 0;
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// Eased scrolling for the detail modal on the TV (a plain scrollBy jumps, which makes the synopsis
// hard to read). glideTo() sets an absolute target (focus-driven moves, measured from where the
// panel is *now*, so they must replace the target rather than add to it); glideBy() extends the
// current target, so holding Down keeps gliding instead of stuttering.
const glide = new WeakMap();
function glideState(el) {
  let st = glide.get(el);
  if (!st) { st = { target: el.scrollTop, raf: 0, last: -1, still: 0 }; glide.set(el, st); }
  return st;
}
function glideTo(el, to) {
  if (reducedMotion()) { el.scrollTop = to; return; }
  const st = glideState(el);
  st.target = to;
  if (st.raf) return;
  st.last = -1;
  st.still = 0;
  const step = () => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);   // content can grow while images load
    st.target = Math.max(0, Math.min(max, st.target));
    const cur = el.scrollTop;
    const d = st.target - cur;
    if (Math.abs(d) < 0.6) { el.scrollTop = st.target; st.raf = 0; return; }
    el.scrollTop = cur + d * 0.18 + Math.sign(d) * 0.4;       // ease out, small floor so it always lands
    st.still = Math.abs(el.scrollTop - st.last) < 0.01 ? st.still + 1 : 0;
    st.last = el.scrollTop;
    if (st.still >= 3) { st.raf = 0; return; }                // could not move (at a bound): stop, never spin
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}
function glideBy(el, delta) {
  const st = glideState(el);
  glideTo(el, (st.raf ? st.target : el.scrollTop) + delta);
}

function reveal(n, dir) {
  const handled = !n.dispatchEvent(new CustomEvent('tv:reveal', { bubbles: true, cancelable: true, detail: { dir } }));
  if (handled) return;
  const tv = isTV();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Horizontal: bring the card into view (scrollable rows scroll themselves).
  let r = n.getBoundingClientRect();
  const m = vw * 0.02;
  if (r.left < m || r.right > vw - m) {
    try { n.scrollIntoView({ block: 'nearest', inline: tv ? 'center' : 'nearest' }); } catch {}
    r = n.getBoundingClientRect();
  }

  // Vertical: keep the focused row clear of the fixed nav and the bottom edge.
  if (tv && !n.closest('.dm-layer') && n.closest('.hero') && window.scrollY > 1) {
    // The billboard's own buttons: show the whole billboard, not just the part that happens to be in view.
    try { window.scrollTo({ top: 0, left: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { window.scrollTo(0, 0); }
    return;
  }
  if (n.closest('#nav')) {
    // Up into the header on the TV: bring the page all the way back to the top so the billboard shows whole.
    if (tv && !n.closest('.dm-layer') && window.scrollY > 1) {
      try { window.scrollTo({ top: 0, left: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { window.scrollTo(0, 0); }
    }
    return;
  }
  const layer = n.closest('.dm-layer');
  const top0 = layer ? 0 : navBottom();
  const padTop = top0 + 12;
  const padBottom = vh - 12;
  // Browse / search grids on the TV: the focused card's row is held just under the nav and the titles
  // scroll up past it, so the info panel pinned to the bottom never covers the card you are on.
  if (tv && !layer && n.closest('.bgrid')) {
    const gr = n.getBoundingClientRect();
    const d = gr.top - (top0 + 14);
    if (Math.abs(d) > 2) { try { window.scrollBy({ top: d, left: 0, behavior: 'auto' }); } catch { window.scrollBy(0, d); } }
    return;
  }
  const keepBelow = vh * (tv ? 0.25 : 0.08);
  const keepAbove = vh * 0.1;
  // The row's top (its title) is the anchor; its bottom only counts when the whole row fits.
  // Tall rows (posters / Top 10 + the TV info panel) fall back to the card's bottom, and may
  // let the panel run off the bottom edge rather than push the title under the nav.
  const row = n.closest(ROW_SEL);
  const rr = row ? row.getBoundingClientRect() : r;
  const top = rr.top;
  const bottom = rr.height <= padBottom - padTop ? rr.bottom : r.bottom;
  let delta = 0;
  if (top < padTop) delta = top - (padTop + (rr.height + keepAbove <= padBottom - padTop ? keepAbove : 0));
  else if (bottom > padBottom) delta = Math.min(bottom - (padBottom - keepBelow), top - padTop);
  if (!delta) return;
  const smooth = !tv && !reducedMotion();
  if (tv && layer) {
    // Landing on the hero's buttons (Play / favourite / watched): show the whole hero again.
    glideTo(layer, dir === 'up' && n.closest('.dm-actions') ? 0 : layer.scrollTop + delta);
    return;
  }
  const scroller = layer || window;
  try { scroller.scrollBy({ top: delta, left: 0, behavior: smooth ? 'smooth' : 'auto' }); }
  catch { scroller.scrollBy(0, delta); }
}

function focusEl(n, dir) {
  try { n.focus({ preventScroll: true }); } catch { n.focus(); }
  reveal(n, dir);
}

function firstUsable(list) {
  for (const k of list) if (usable(k.el)) return k.el;
  return null;
}

function startTarget() {
  const m = modalRoot();
  if (m) {
    return m.querySelector('[data-k="play"]') || firstUsable(collect([m]).sort((a, b) => (a.t - b.t) || (a.l - b.l)));
  }
  const view = document.getElementById('view');
  const nb = navBottom();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const list = collect([view]).filter((k) => k.b > nb && k.t < vh && k.r > 0 && k.l < vw);
  if (list.length) {
    const play = list.find((k) => k.el.classList.contains('btn-play') && usable(k.el));
    if (play) return play.el;
    list.sort((a, b) => (a.t - b.t) || (a.l - b.l));
    const hit = firstUsable(list);
    if (hit) return hit;
  }
  return firstUsable(collect([document.getElementById('nav')]).sort((a, b) => (a.l - b.l)));
}

// ---- key helpers ---------------------------------------------------------------------------------
function dirOf(e) {
  if (DIRS[e.key]) return DIRS[e.key];
  if ((!e.key || e.key === 'Unidentified') && CODE_DIRS[e.keyCode]) return CODE_DIRS[e.keyCode];
  return null;
}

function isBackKey(e, editable) {
  const k = e.key;
  if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || e.keyCode === 4 || e.keyCode === 27 || e.keyCode === 166) return true;
  if (k === 'Backspace' && isTV() && !editable) return true;
  return false;
}

function isMediaPlay(e) {
  const k = e.key;
  if (k === 'MediaPlayPause' || k === 'MediaPlay' || e.keyCode === 179) return true;
  return isTV() && e.keyCode === 85 && !/^u$/i.test(k || '');
}

// One Back step, shared by the keyboard handler and the native Fire TV app (window.__myflixBack).
// Returns true if something was closed / navigated, false when already on home with nothing open.
function closeModal() { if (!closeRequest() && !closeSuggest()) closeDetail(); }   // request sheet first, else the detail modal

function closeTopLayer() {
  const sm = document.querySelector('.dm-season-menu:not([hidden])');   // TV season list closes before the card does
  if (sm && sm.closeMenu) { sm.closeMenu(true); return true; }
  if (modalRoot()) { closeModal(); return true; }
  const nav = document.getElementById('nav');
  if (nav && (nav.classList.contains('menu-open') || nav.querySelector('.nav-profile.open'))) {
    document.body.click();   // nav closes its menus on any outside click
    return true;
  }
  const si = nav && nav.classList.contains('search-open') ? nav.querySelector('.nav-search-input') : null;
  if (si) {   // nav's own Escape handling clears the box, collapses it and leaves #/search
    si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}

function backStep() {
  if (closeTopLayer()) return true;
  const h = location.hash;
  if (!h || h === '#' || h === '#/') return false;
  const now = performance.now();
  if (now - lastBackAt < 350 || now - lastPopAt < 250) return true;   // swallow key-repeat double Backs
  const idx = history.state && typeof history.state.mfIdx === 'number' ? history.state.mfIdx : 0;
  if (idx > 1) { lastBackAt = now; history.back(); return true; }
  if (/^#\/profiles/.test(h) && !store.get('profile')) return false;   // nothing to go back to
  lastBackAt = now;
  location.replace('#/');   // first entry of the session: no SPA history to pop, so go home
  return true;
}

// The remote's Home key sends the app to Fire TV's home screen (apps can't intercept it), so the
// native app calls this on the way out: close whatever is open and park on MyFlix's own Home, so
// coming back lands there instead of on whatever page was left.
function goHome() {
  for (let i = 0; i < 4 && closeTopLayer(); i++);
  const h = location.hash;
  if ((!h || h === '#' || h === '#/') || (/^#\/profiles/.test(h) && !store.get('profile'))) return;
  location.replace('#/');
  window.scrollTo(0, 0);
}

function handleBack(e) {
  const t = document.activeElement;
  const editable = isTextInput(t);
  if (editable && (e.key === 'Escape' || e.key === 'Backspace')) return;   // the field / nav search owns these
  if (t && t.tagName === 'SELECT' && e.key === 'Escape') return;
  const sm = document.querySelector('.dm-season-menu:not([hidden])');   // TV season list: Back closes it, not the whole card
  if (sm && sm.closeMenu) { e.preventDefault(); sm.closeMenu(true); return; }
  if (editable && !isTV()) return;
  if (modalRoot()) {
    e.preventDefault();
    closeModal();
    return;
  }
  if (!isTV()) return;   // desktop: the browser's own Back button / shortcut does this
  e.preventDefault();
  if (backStep()) return;
  const now = performance.now();   // already home: fall through to the browser's own Back
  if (now - lastBackAt < 350 || now - lastPopAt < 250) return;
  lastBackAt = now;
  history.back();
}

function handleMediaPlay(e) {
  const a = document.activeElement;
  if (!a || a === document.body) return;
  const m = modalRoot();
  if (m && m.contains(a)) {
    const p = m.querySelector('.dm-play');
    if (p) { e.preventDefault(); p.click(); }
    return;
  }
  const card = a.closest('[data-id]');
  if (card && card.dataset.id) {
    e.preventDefault();
    location.href = '/play/' + encodeURIComponent(card.dataset.id);
  }
}

// A focused element that isn't itself a control but holds controls: a tabindex=-1 wrapper, or a
// scroll container Chrome made focusable (the detail layer on the TV).
const CONTROL = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
function isContainer(n) {
  return !!n && n instanceof Element && !n.matches(CONTROL) && !!n.querySelector(FOCUSABLE);
}

function handleSelect(e) {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return;
  if (isTV() && isContainer(a)) {   // nothing to activate on a container: land focus instead
    const t = startTarget();
    if (t) { e.preventDefault(); focusEl(t, null); }
    return;
  }
  if (isTextInput(a) || a.tagName === 'SELECT') return;   // native: soft keyboard / picker / submit
  const native = a.matches('a[href],button,summary,input');
  const enter = e.key === 'Enter' || e.keyCode === 13;
  if (enter && native) return;                              // browser fires the click itself
  if (performance.now() - lastClickAt < 60) return;         // the element already handled this key
  if (!layerRoots().some((r) => r.contains(a))) return;
  e.preventDefault();
  a.click();
}

function handleDir(e, dir) {
  const a = document.activeElement;
  const tv = isTV();

  if (isTextInput(a)) {
    if (dir === 'up' || dir === 'down') {
      if (!(tv || a.classList.contains('nav-search-input'))) return;
    } else {
      if (!tv) return;
      let s = null;
      let en = null;
      try { s = a.selectionStart; en = a.selectionEnd; } catch {}
      if (s == null || s !== en) return;
      if (dir === 'left' && s !== 0) return;
      if (dir === 'right' && s !== String(a.value || '').length) return;
    }
  } else if (a && a.tagName === 'SELECT' && !tv) {
    return;
  }

  const roots = layerRoots();
  const inLayer = !!a && a !== document.body && a !== document.documentElement && roots.some((r) => r.contains(a));
  if (!inLayer && !tv) return;   // desktop: leave arrow-scrolling alone until focus is inside the UI

  // A focused container (e.g. the modal's tabindex=-1 layer after returning from the native
  // player) spans the whole screen, so nothing lies "beside" it — re-enter at the start target.
  if (!inLayer || isContainer(a)) {
    const t = startTarget();
    if (t) { focusEl(t, dir); e.preventDefault(); }
    return;
  }
  const next = pick(a, dir);
  if (next) { focusEl(next, dir); e.preventDefault(); }
  else if (tv) {
    e.preventDefault();   // never let the TV browser scroll the page itself
    // Nothing to move to inside a modal (e.g. a request sheet whose only control is ✕): scroll
    // the modal's text instead, so Up/Down still reads the rest of it.
    const layer = (dir === 'up' || dir === 'down') && a && a.closest && a.closest('.dm-layer');
    if (layer && layer.scrollHeight > layer.clientHeight + 4) {
      glideBy(layer, (dir === 'down' ? 1 : -1) * layer.clientHeight * 0.4);
    }
  }
}

function onKeyDown(e) {
  if (e.defaultPrevented) return;
  const root = document.documentElement;
  const dir = dirOf(e);
  if (dir || e.key === 'Tab' || e.key === 'Enter') root.classList.add('kbd');

  if (isBackKey(e, isTextInput(document.activeElement))) { handleBack(e); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (isMediaPlay(e)) { handleMediaPlay(e); return; }
  if (dir) { handleDir(e, dir); return; }
  if (e.key === 'Enter' || e.keyCode === 13 || e.keyCode === 23) handleSelect(e);
}

// ---- focus restore when coming back to a view ----------------------------------------------------------
function cssEsc(s) {
  try { return CSS.escape(s); } catch { return String(s).replace(/[^\w-]/g, '\\$&'); }
}

function stopWatching() {
  if (observer) { observer.disconnect(); observer = null; }
  clearTimeout(observerTimer);
  observerTimer = 0;
}

function rememberFocus(hash) {
  const a = document.activeElement;
  const view = document.getElementById('view');
  if (!hash || !a || !view || !view.contains(a)) return;
  const card = a.closest('[data-id]');
  if (card && card.dataset.id) viewMem.set(hash, { id: card.dataset.id });
}

function watchForContent(wantId) {
  stopWatching();
  const view = document.getElementById('view');
  if (!view) return;
  const tv = isTV();
  if (!tv && !(wantId && document.documentElement.classList.contains('kbd'))) return;
  let settle = 0;
  const attempt = () => {
    const a = document.activeElement;
    const nav = document.getElementById('nav');
    const inView = !!a && a !== document.body && view.contains(a);
    const inNav = !!a && !!nav && nav.contains(a);
    if (inView || (inNav && !wantId)) { stopWatching(); return; }   // user already moved / is browsing the nav
    let target = null;
    if (wantId) {
      try { target = view.querySelector('[data-id="' + cssEsc(wantId) + '"]'); } catch {}
      if (target && !(target.tabIndex >= 0 || target.matches(FOCUSABLE))) target = target.querySelector(FOCUSABLE);
      if (target && !usable(target)) target = null;
    }
    if (!target && tv && !wantId) {
      const s = startTarget();
      if (s && view.contains(s)) target = s;
    }
    if (target) { stopWatching(); focusEl(target, null); }
  };
  observer = new MutationObserver(() => { clearTimeout(settle); settle = setTimeout(attempt, 90); });
  observer.observe(view, { childList: true, subtree: true });
  observerTimer = setTimeout(stopWatching, 5000);
  settle = setTimeout(attempt, 150);
}

// ---- init -------------------------------------------------------------------------------------------------
export function initTV() {
  if (started) return;
  started = true;

  document.addEventListener('keydown', onKeyDown);
  window.__myflixBack = backStep;   // native Fire TV app: exit only when this returns false
  window.__myflixHome = goHome;     // native Fire TV app: the remote's Home key was pressed
  document.addEventListener('click', () => { lastClickAt = performance.now(); }, true);
  window.addEventListener('popstate', () => { lastPopAt = performance.now(); });

  // Focus rings: keyboard / D-pad only. Mouse and touch switch them off again.
  const off = () => document.documentElement.classList.remove('kbd');
  document.addEventListener('mousedown', off, true);
  document.addEventListener('touchstart', off, { capture: true, passive: true });

  // Remember each row's last-focused card.
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const row = rowOf(t);
    if (row) rowMem.set(row, t);
  });

  // Coming back from the native player (or any app switch) the WebView can hand focus to the
  // modal layer or <body>; put it back on the last real control, else the layer's start target.
  let lastStop = null;
  // The Fire TV WebView re-focuses itself after in-page navigations (opening / closing a title
  // changes the hash), and Chromium answers that by focusing the first control in the document:
  // the modal's close button, or the nav logo. Nobody pressed anything, so undo the jump.
  let lastMoveAt = -1e9;
  const moved = () => { lastMoveAt = performance.now(); };
  document.addEventListener('keydown', (e) => { if (dirOf(e) || e.key === 'Tab') moved(); }, true);
  document.addEventListener('mousedown', moved, true);
  document.addEventListener('touchstart', moved, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    const prev = lastStop;
    if (!isTV() || !(t instanceof Element) || !t.matches('.dm-close, .nav-logo')) return;
    if (performance.now() - lastMoveAt < 600) return;
    if (!prev || prev === t || !prev.isConnected || !usable(prev)) return;
    const modal = document.getElementById('modal-root');
    if (modal && modal.contains(t) !== modal.contains(prev)) return;   // never jump across the modal edge
    setTimeout(() => { if (document.activeElement === t && prev.isConnected) focusEl(prev, null); }, 0);
  }, true);
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t instanceof Element && !isContainer(t)) lastStop = t;
  });
  const restore = () => {
    if (!isTV() || document.visibilityState !== 'visible') return;
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement && !isContainer(a)) return;
      const inLayer = lastStop && lastStop.isConnected && layerRoots().some((r) => r.contains(lastStop)) && usable(lastStop);
      const t = inLayer ? lastStop : startTarget();
      if (t) focusEl(t, null);
    }, 60);
  };
  document.addEventListener('visibilitychange', restore);
  window.addEventListener('focus', restore);
  window.addEventListener('pageshow', restore);

  store.on('route', (r) => {
    if (!r || r.name === 'title') return;   // the modal sits over the same view
    const prev = curHash;
    curHash = r.hash;
    if (prev && prev !== r.hash) rememberFocus(prev);
    watchForContent(viewMem.get(r.hash) ? viewMem.get(r.hash).id : null);
  });
}
