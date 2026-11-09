// Floating hover card (desktop) + info panel under the focused row (TV).
import * as store from '../store.js';
import { el, icon, fmtRuntime, fmtSeasons, isTV, toast } from '../util.js';
import { imgUrl } from '../img.js';
import { getItem, setFavorite, setPlayed } from '../api.js';
import { epLabel, landscapeUrl, openTitle, playItem } from './rows.js';
import { seasonButtons } from './seasonal.js';

const OPEN_DELAY = 400;
const NEXT_DELAY = 280;

// ---- next-up knowledge (series id -> episode) --------------------------------------
const hints = new Map();      // seeded by home.js from /api/home
const nextCache = new Map();  // fetched lazily from /api/item/<id>

export function setNextUpHint(ep) {
  if (ep && ep.seriesId) hints.set(ep.seriesId, ep);
}
function knownNext(seriesId) {
  if (hints.has(seriesId)) return hints.get(seriesId);
  if (nextCache.has(seriesId)) return nextCache.get(seriesId);
  return undefined;
}
// Calls cb(ep|null) once known (immediately when cached). Returns a cancel function.
function lookupNext(seriesId, cb, delay) {
  const k = knownNext(seriesId);
  if (k !== undefined) { cb(k); return () => {}; }
  let dead = false;
  const t = setTimeout(() => {
    getItem(seriesId).then((d) => {
      const ep = (d && d.nextUp) || null;
      nextCache.set(seriesId, ep);
      if (!dead) cb(ep);
    }).catch(() => {});
  }, delay);
  return () => { dead = true; clearTimeout(t); };
}

// ---- view model -------------------------------------------------------------------
function rawFor(card) {
  if (!card) return null;
  const id = card.dataset && card.dataset.id;
  return card._item || (id && store.get('byId').get(id)) || null;
}

function viewModel(raw) {
  const byId = store.get('byId');
  const isEp = raw.type === 'Episode';
  const series = isEp ? (byId.get(raw.seriesId) || null) : null;
  const base = isEp ? (series || raw) : (byId.get(raw.id) || raw);
  const favId = isEp ? raw.seriesId : raw.id;
  const favItem = byId.get(favId) || base;
  const isSeries = !isEp && base.type === 'Series';
  const score = base.score;
  let runtime = '';
  if (isEp) runtime = fmtRuntime(raw.runtimeMin);
  else if (isSeries) runtime = base.seasons ? fmtSeasons(base.seasons) : '';
  else runtime = fmtRuntime(base.runtimeMin);
  return {
    raw, base, isEp, isSeries,
    name: isEp ? (raw.seriesName || base.name || '') : (base.name || ''),
    titleId: isEp ? raw.seriesId : raw.id,
    playId: raw.id,
    favId,
    watchId: raw.id,
    favorite: !!favItem.favorite,
    played: isEp ? !!raw.played : !!base.played,
    score: score ? Number(score) : null,
    rating: base.rating || '',
    year: base.year ? String(base.year) : '',
    runtime,
    genres: (base.genres || []).slice(0, 3).join(' • '),
    overview: (isEp ? raw.overview : '') || base.overview || '',
    next: isEp ? raw : null,
  };
}

// ---- shared DOM builders -------------------------------------------------------------
function metaLine(vm) {
  const bits = [];
  if (vm.score != null) bits.push(el('span', { class: 'hc-match' }, '\u2605 ' + vm.score.toFixed(1)));
  if (vm.year) bits.push(el('span', { class: 'hc-year' }, vm.year));
  if (vm.rating) bits.push(el('span', { class: 'badge-rating' }, vm.rating));
  if (vm.runtime) bits.push(el('span', { class: 'hc-rt' }, vm.runtime));
  bits.push(el('span', { class: 'badge-hd' }, 'HD'));
  return el('div', { class: 'hc-meta' }, bits);
}

function nextLine(ep) {
  if (!ep) return null;
  const pct = Number(ep.playedPct) || 0;
  const lab = epLabel(ep);
  const line = el('div', { class: 'hc-next' },
    el('div', { class: 'hc-next-text' },
      lab ? el('span', { class: 'hc-next-lbl' }, lab) : null,
      lab && ep.name ? ' · ' : null,
      ep.name || ''));
  if (pct > 0 && pct < 100) {
    line.append(el('div', { class: 'card-progress' }, el('span', { style: { width: Math.max(2, pct) + '%' } })));
  }
  return line;
}

function svg(path, size = 20, fill = 'none') {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="${fill}" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
const THUMB = '<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zM7 11l4-7a2 2 0 0 1 2 2v4h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17 20H7"/>';
const DOWN = '<path d="M6 9l6 6 6-6"/>';

// ---- floating card ---------------------------------------------------------------------
let rootEl = null;
let hoverRoot = null;
let openTimer = 0;
let closeTimer = 0;
let pending = null; // card waiting out the open delay
let current = null; // {card, hc, vm, cancelNext, from}
let modalOpen = false;

function canHover() {
  if (isTV() || modalOpen) return false;
  if (document.documentElement.classList.contains('touch')) return false;
  try { return window.matchMedia('(hover: hover)').matches; } catch { return true; }
}

function buildHover(vm, W) {
  const art = landscapeUrl(vm.raw, 480) || landscapeUrl(vm.base, 480);
  const art2 = landscapeUrl(vm.raw, 640) || landscapeUrl(vm.base, 640);
  const media = el('div', { class: 'hc-media' });
  if (art) {
    const img = el('img', { class: 'img', src: art, alt: '', decoding: 'async', draggable: 'false' });
    if (art2 && art2 !== art) { img.setAttribute('srcset', art + ' 480w, ' + art2 + ' 640w'); img.setAttribute('sizes', W + 'px'); }
    img.addEventListener('error', () => img.remove(), { once: true });
    media.append(img);
  }
  const logoUrl = imgUrl(vm.base, 'Logo', 240);
  const title = () => el('div', { class: 'hc-title' }, vm.name);
  if (logoUrl && !vm.isEp) {
    const logo = el('img', { class: 'hc-logo', src: logoUrl, alt: vm.name, decoding: 'async', draggable: 'false' });
    logo.addEventListener('error', () => { if (logo.isConnected) logo.replaceWith(title()); }, { once: true });
    media.append(logo);
  } else {
    media.append(title());
  }

  const btn = (act, label, cls, html) => el('button', {
    class: 'btn-circle hc-btn ' + cls, type: 'button', 'data-act': act, title: label, 'aria-label': label, html,
  });
  const play = btn('play', 'Play', 'is-filled', icon('play', 18));
  const fav = btn('fav', vm.favorite ? 'Remove from My List' : 'Add to My List', 'hc-fav', icon(vm.favorite ? 'check' : 'plus', 18));
  const seen = btn('seen', vm.played ? 'Mark as unwatched' : 'Mark as watched', 'hc-seen', svg(THUMB, 18, vm.played ? 'currentColor' : 'none'));
  const more = btn('more', 'More info', 'hc-more', svg(DOWN, 20));
  fav.classList.toggle('is-on', vm.favorite);
  seen.classList.toggle('is-on', vm.played);

  const panel = el('div', { class: 'hc-panel' },
    el('div', { class: 'hc-actions' }, play, fav, seen, ...seasonButtons(vm.raw, 'btn-circle hc-btn'), more),
    metaLine(vm));
  if (vm.genres) panel.append(el('div', { class: 'hc-genres' }, vm.genres));
  if (vm.overview) panel.append(el('p', { class: 'hc-syn' }, vm.overview));
  panel.append(el('div', { class: 'hc-next-slot' }));

  const hc = el('div', { class: 'hc', role: 'dialog', 'aria-label': vm.name, style: { width: W + 'px' } }, media, panel);
  return hc;
}

function fillNext(hc, ep) {
  const slot = hc.querySelector('.hc-next-slot');
  if (!slot) return;
  slot.replaceChildren();
  const n = nextLine(ep);
  if (n) slot.append(n);
}

function setLabel(node, text) {
  node.setAttribute('title', text);
  node.setAttribute('aria-label', text);
}
function paintButtons(vm) {
  if (!current) return;
  const fav = current.hc.querySelector('.hc-fav');
  const seen = current.hc.querySelector('.hc-seen');
  if (fav) {
    fav.classList.toggle('is-on', vm.favorite);
    fav.innerHTML = icon(vm.favorite ? 'check' : 'plus', 18);
    setLabel(fav, vm.favorite ? 'Remove from My List' : 'Add to My List');
  }
  if (seen) {
    seen.classList.toggle('is-on', vm.played);
    seen.innerHTML = svg(THUMB, 18, vm.played ? 'currentColor' : 'none');
    setLabel(seen, vm.played ? 'Mark as unwatched' : 'Mark as watched');
  }
}
function syncButtons() {
  if (!current) return;
  const vm = viewModel(current.vm.raw);
  current.vm = vm;
  paintButtons(vm);
}

async function toggleFav(vm) {
  const next = !vm.favorite;
  paintButtons(Object.assign({}, vm, { favorite: next })); // optimistic
  try {
    await setFavorite(vm.favId, next);
  } catch {
    toast('Could not update My List');
  }
  syncButtons();
}
async function toggleSeen(vm) {
  const next = !vm.played;
  paintButtons(Object.assign({}, vm, { played: next }));
  try {
    await setPlayed(vm.watchId, next);
    if (vm.isEp) vm.raw.played = next; // episodes aren't in the index, patch the card's own copy
  } catch {
    toast('Could not update watched state');
  }
  syncButtons();
}

function onHoverClick(e) {
  if (!current) return;
  const b = e.target.closest('[data-act]');
  const vm = current.vm;
  if (!b) { closeNow(); openTitle(vm.raw); return; }
  e.stopPropagation();
  const act = b.dataset.act;
  if (act === 'play') playItem({ id: vm.playId });
  else if (act === 'more') { closeNow(); openTitle(vm.raw); }
  else if (act === 'fav') toggleFav(vm);
  else if (act === 'seen') toggleSeen(vm);
}

function open(card) {
  if (!card.isConnected) return;
  const raw = rawFor(card);
  if (!raw) return;
  const vm = viewModel(raw);
  const imgRect = (card.querySelector('.card-img') || card).getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if (imgRect.width < 24 || imgRect.bottom < 0 || imgRect.top > vh) return;

  let W = Math.round(Math.min(400, Math.max(300, imgRect.width * 1.5)));
  W = Math.min(W, vw - 16);
  const hc = buildHover(vm, W);
  hc.style.visibility = 'hidden';
  hoverRoot.append(hc);
  const H = hc.offsetHeight;
  const imgH = Math.round(W * 9 / 16);

  // Image area centered on the card art; edge cards anchor instead of centering.
  const cx = imgRect.left + imgRect.width / 2;
  const cy = imgRect.top + imgRect.height / 2;
  let left = Math.round(cx - W / 2);
  if (left < vw * 0.02) left = Math.round(imgRect.left);
  else if (left + W > vw * 0.98) left = Math.round(imgRect.right - W);
  left = Math.max(8, Math.min(vw - W - 8, left));
  let top = Math.round(cy - imgH / 2);
  if (top + H > vh - 12) top = vh - H - 12;
  const nav = document.getElementById('nav');
  const minTop = Math.max(8, (nav ? nav.getBoundingClientRect().bottom : 0) + 4);
  if (top < minTop) top = minTop;

  const s = imgRect.width / W;
  const iy = cy - (imgH * s) / 2;
  const from = `translate(${(imgRect.left - left).toFixed(1)}px, ${(iy - top).toFixed(1)}px) scale(${s.toFixed(4)})`;

  hc.style.left = left + 'px';
  hc.style.top = top + 'px';
  hc.style.transition = 'none';
  hc.style.transform = from;
  hc.style.visibility = '';
  hc.getBoundingClientRect(); // commit the start state
  hc.style.transition = '';
  hc.classList.add('is-open');
  hc.style.transform = 'none';

  hc.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  hc.addEventListener('mouseleave', () => { clearTimeout(closeTimer); closeTimer = setTimeout(closeNow, 50); });
  hc.addEventListener('click', onHoverClick);

  current = { card, hc, vm, from, cancelNext: () => {} };
  if (vm.isSeries) {
    current.cancelNext = lookupNext(vm.raw.id, (ep) => { if (current && current.hc === hc) fillNext(hc, ep); }, NEXT_DELAY);
  } else if (vm.next) {
    fillNext(hc, vm.next);
  }
}

function closeNow() {
  clearTimeout(openTimer);
  pending = null;
  clearTimeout(closeTimer);
  if (!current) return;
  const { hc, from, cancelNext } = current;
  current = null;
  cancelNext();
  hc.classList.remove('is-open');
  hc.classList.add('is-closing');
  hc.style.transform = from;
  const kill = () => hc.remove();
  hc.addEventListener('transitionend', (e) => { if (e.target === hc && e.propertyName === 'transform') kill(); });
  setTimeout(kill, 360);
}

// ---- TV: info panel under the focused row ----------------------------------------------
let tvCancel = () => {};
let gridPanel = null;   // Browse / Search grids have no row to hang the panel on: one fixed panel at the bottom
function tvShow(card) {
  const row = card.closest('.row');
  const grid = !row && card.closest('.bgrid');
  const raw = rawFor(card);
  if (!(row || grid) || !raw) return;
  tvCancel();
  const vm = viewModel(raw);
  let panel = grid ? gridPanel : row.querySelector(':scope > .tv-info');
  if (!panel) {
    panel = el('div', { class: 'tv-info', 'aria-hidden': 'true' });
    if (grid) { panel.classList.add('tv-info-fixed'); document.body.append(panel); gridPanel = panel; }
    else row.append(panel);
  }
  panel.replaceChildren(
    el('div', { class: 'tv-info-title' }, vm.name),
    metaLine(vm));
  if (vm.genres) panel.append(el('div', { class: 'hc-genres' }, vm.genres));
  if (vm.overview) panel.append(el('p', { class: 'hc-syn' }, vm.overview));
  const slot = el('div', { class: 'hc-next-slot' });
  panel.append(slot);
  const put = (ep) => { slot.replaceChildren(); const n = nextLine(ep); if (n) slot.append(n); };
  if (vm.isSeries) tvCancel = lookupNext(vm.raw.id, put, 350);
  else if (vm.next) put(vm.next);
}
function tvHide(row) {
  tvCancel();
  const p = row && row.querySelector(':scope > .tv-info');
  if (p) p.remove();
}
function tvHideGrid() {
  tvCancel();
  if (gridPanel) { gridPanel.remove(); gridPanel = null; }
}

// ---- wiring -------------------------------------------------------------------------------
let started = false;
export function initHoverCards(root) {
  if (started || !root) return;
  started = true;
  rootEl = root;
  hoverRoot = document.getElementById('hover-root') || document.body;

  // TV: no floating card; the focused card's info renders below its row.
  root.addEventListener('focusin', (e) => {
    if (!isTV()) return;
    const card = e.target.closest && e.target.closest('.card');
    if (card) tvShow(card);
  });
  root.addEventListener('focusout', (e) => {
    if (!isTV()) return;
    const row = e.target.closest && e.target.closest('.row');
    if (!row) {
      const g = e.target.closest && e.target.closest('.bgrid');
      if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) tvHideGrid();
      return;
    }
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    tvHide(row);
  });

  root.addEventListener('mouseover', (e) => {
    if (!canHover()) return;
    const card = e.target.closest && e.target.closest('.card');
    if (!card) {
      clearTimeout(openTimer);
      pending = null;
      if (current) closeNow();
      return;
    }
    if (current && current.card === card) { clearTimeout(closeTimer); return; }
    if (!current && pending === card) return; // still waiting on this card
    if (current) closeNow();
    clearTimeout(openTimer);
    pending = card;
    openTimer = setTimeout(() => {
      pending = null;
      if (canHover() && card.matches(':hover')) open(card);
    }, OPEN_DELAY);
  });
  root.addEventListener('mouseout', (e) => {
    if (current) return; // the floating card handles its own leave
    const card = e.target.closest && e.target.closest('.card');
    if (!card) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    clearTimeout(openTimer);
    pending = null;
  });
  root.addEventListener('mouseleave', () => { clearTimeout(openTimer); pending = null; });

  const onScroll = () => { clearTimeout(openTimer); pending = null; if (current) closeNow(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', closeNow);
  window.addEventListener('blur', closeNow);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNow(); });

  store.on('route', () => { closeNow(); tvHideGrid(); });
  store.on('modal:open', () => { modalOpen = true; closeNow(); });
  store.on('modal:close', () => { modalOpen = false; });
  store.on('item:changed', (d) => {
    if (d && d.id != null) nextCache.delete(d.id);
    if (!current) return;
    if (!current.card.isConnected) { closeNow(); return; }
    syncButtons();
  });
}
