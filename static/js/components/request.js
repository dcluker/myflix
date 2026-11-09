// Request sheet: asks Jellyseerr for a title the library doesn't have yet. openRequest(item, {onStatus}) / closeRequest().
//
// Same conventions as the detail modal so tv.js treats it as the active layer:
//  - lives in #modal-root as a .dm-layer > .dm-box, emits modal:open / modal:close, locks scroll,
//    makes #nav and #view inert;
//  - the primary button carries data-k="play" (tv.js startTarget lands on it) and the layer bounces
//    stray focus back to it;
//  - Esc / Back is owned by tv.js, which calls closeRequest() before closeDetail().
// item is a /api/discover/search row: {tmdbId, mediaType, title, year, overview, poster, backdrop, score, status, jellyfinId}.
import * as store from '../store.js';
import { discoverTv, requestTitle } from '../api.js';
import { placeholderEl } from '../img.js';
import { el, icon, toast } from '../util.js';

const TABBABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const STATUS_BADGE = { pending: 'Requested', processing: 'Searching', searching: 'Searching', downloading: 'Downloading', noRelease: 'No release found', partial: 'Partly available', available: 'Available' };

let layer = null;      // .dm-layer
let box = null;        // .dm-box
let ctx = null;        // per-open state
let opener = null;     // element to hand focus back to on close
let offs = [];         // teardown callbacks for document-level listeners
let saved = null;      // body styles to restore on unlock

// TMDB image with a title-tile fallback (never a broken-image icon).
export function tmdbImgEl(url, title, cls = '') {
  if (!url) return placeholderEl({ name: title }, cls);
  const img = el('img', {
    class: ('img ' + cls).trim(), src: url, alt: title || '', loading: 'lazy', decoding: 'async',
    draggable: 'false', referrerpolicy: 'no-referrer',
  });
  img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(placeholderEl({ name: title }, cls)); }, { once: true });
  return img;
}

// ---- mount / unmount (same shape as detail.js) ------------------------------------------------
function lockScroll() {
  const b = document.body;
  const sb = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  saved = { overflow: b.style.overflow, pad: b.style.paddingRight };
  b.style.overflow = 'hidden';
  if (sb > 0) b.style.paddingRight = sb + 'px';
  document.documentElement.classList.add('dm-open');
}

function unlockScroll() {
  if (saved) {
    document.body.style.overflow = saved.overflow;
    document.body.style.paddingRight = saved.pad;
    saved = null;
  }
  document.documentElement.classList.remove('dm-open');
}

function setBackgroundInert(on) {
  for (const id of ['nav', 'view']) {
    const n = document.getElementById(id);
    if (!n) continue;
    try { n.inert = on; } catch {}
    if (on) n.setAttribute('aria-hidden', 'true'); else n.removeAttribute('aria-hidden');
  }
}

function tabbables() {
  if (!layer) return [];
  return Array.from(layer.querySelectorAll(TABBABLE)).filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0);
}

function focusPrimary() {
  if (!layer) return;
  const t = layer.querySelector('[data-k="play"]:not([disabled])') || layer.querySelector('.dm-close');
  if (t) { try { t.focus({ preventScroll: true }); } catch { t.focus(); } }
}

function hardReset() {
  for (const f of offs) { try { f(); } catch {} }
  offs = [];
  if (layer) layer.remove();
  layer = box = ctx = null;
  unlockScroll();
  setBackgroundInert(false);
}

// Returns true if a sheet was open (tv.js uses that to decide whether Back is spent).
export function closeRequest() {
  if (!layer) return false;
  const back = opener;
  opener = null;
  hardReset();
  if (back && back.isConnected && typeof back.focus === 'function') {
    try { back.focus({ preventScroll: true }); } catch { back.focus(); }
  }
  store.emit('modal:close');
  return true;
}

export function isRequestOpen() { return !!layer; }

function mount(root) {
  const a = document.activeElement;
  opener = a && a !== document.body && a.isConnected && document.getElementById('view')?.contains(a) ? a : null;

  layer = el('div', { class: 'dm-layer rq-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Request a title' });
  box = el('div', { class: 'dm-box rq-box' });
  layer.appendChild(box);

  // Close only when both press and release happen on the dim backdrop.
  let downOnLayer = false;
  layer.addEventListener('mousedown', (e) => { downOnLayer = e.target === layer; });
  layer.addEventListener('click', (e) => { if (e.target === layer && downOnLayer) closeRequest(); downOnLayer = false; });

  root.appendChild(layer);
  lockScroll();

  const onKey = (e) => {
    if (e.key !== 'Tab' || !layer) return;
    const list = tabbables();
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const cur = document.activeElement;
    const inside = layer.contains(cur);
    if (e.shiftKey && (!inside || cur === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || cur === last)) { e.preventDefault(); first.focus(); }
  };
  const onFocusIn = (e) => {
    if (!layer || e.target === document.body) return;
    // The scroll layer can take focus itself on the TV (open, or back from the native player): bounce it.
    if (e.target === layer || e.target === box) { focusPrimary(); return; }
    if (layer.contains(e.target)) return;
    focusPrimary();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn);
  offs = [
    () => document.removeEventListener('keydown', onKey, true),
    () => document.removeEventListener('focusin', onFocusIn),
    store.on('route', () => closeRequest()),
  ];

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!layer) return;
    layer.classList.add('open');
    if (!layer.contains(document.activeElement) || document.activeElement === layer) focusPrimary();
  }));
}

// ---- content ------------------------------------------------------------------------------------
function statusLine(me) {
  const it = me.item;
  switch (me.state) {
    case 'pending': return 'Requested. Waiting for approval.';
    case 'processing':
    case 'searching': return 'Approved. Looking for a download. This can take a while.';
    case 'downloading': return 'Downloading now. It will appear in MyFlix when it\'s ready.';
    case 'noRelease': return 'No download found yet. It keeps searching.';
    case 'partial': return me.isTv ? 'Some seasons are in MyFlix; the rest aren\'t yet.' : 'Partly available in MyFlix.';
    case 'available': return it.jellyfinId ? 'Available in MyFlix.' : 'Available. It may take a minute to show up in MyFlix.';
    default: return 'Not in MyFlix yet. Request it and it will appear here when it\'s ready.';
  }
}

// Which request buttons to offer: [{label, seasons, primary}]. Empty = nothing to request.
function requestOptions(me) {
  if (!me.isTv) return me.state === 'none' ? [{ label: 'Request', seasons: null }] : [];
  if (!me.seasons) return me.state === 'none' ? [{ label: 'Request all seasons', seasons: 'all' }, { label: 'Request Season 1', seasons: [1] }] : [];
  const open = me.seasons.filter((s) => s.status === 'none').map((s) => s.season);
  if (!open.length) return [];
  if (open.length === 1) return [{ label: 'Request Season ' + open[0], seasons: [open[0]] }];
  const all = open.length === me.seasons.length;
  return [{ label: all ? 'Request all seasons' : 'Request remaining seasons', seasons: all ? 'all' : open },
    { label: 'Request Season ' + open[0], seasons: [open[0]] }];
}

function paintActions(force) {
  const me = ctx;
  if (!me) return;
  let sig;
  let nodes;
  if (me.done) {
    sig = 'done:' + me.done;
    if (!force && me.sig === sig) return;
    nodes = [el('button', { class: 'btn-play rq-btn', type: 'button', disabled: true, 'data-k': 'done' },
      el('span', { class: 'dm-ic', html: icon('check', 22) }),
      el('span', null, me.done === 'approved' ? 'Approved — downloading' : 'Requested'))];
  } else if (me.state === 'available' && me.item.jellyfinId) {
    sig = 'open';
    if (!force && me.sig === sig) return;
    nodes = [el('button', {
      class: 'btn-play rq-btn', type: 'button', 'data-k': 'play',
      onclick: () => { const id = me.item.jellyfinId; closeRequest(); location.hash = '#/title/' + encodeURIComponent(id); },
    }, el('span', { class: 'dm-ic', html: icon('play', 22) }), el('span', null, 'Open in MyFlix'))];
  } else {
    const opts = requestOptions(me);
    sig = 'req:' + opts.map((o) => o.label).join('|');
    if (!force && me.sig === sig) return;
    nodes = opts.map((o, i) => el('button', {
      class: (i === 0 ? 'btn-play' : 'btn-info') + ' rq-btn', type: 'button',
      'data-k': i === 0 ? 'play' : null,
      onclick: (e) => submit(o, e.currentTarget),
    }, i === 0 ? el('span', { class: 'dm-ic', html: icon('plus', 22) }) : null, el('span', null, o.label)));
  }
  const hadFocus = me.actionsEl.contains(document.activeElement);
  me.sig = sig;
  me.actionsEl.replaceChildren(...nodes);
  if (hadFocus) focusPrimary();
}

function paintStatus() {
  const me = ctx;
  me.statusEl.textContent = statusLine(me);
  me.statusEl.dataset.state = me.state;
}

function showError(msg) {
  const me = ctx;
  if (!me) return;
  me.errEl.textContent = msg || '';
  me.errEl.hidden = !msg;
}

function errorText(e) {
  const code = e && e.code;
  if (code === 'no_seerr_user') return 'Your profile isn\'t set up for requests yet. Ask the owner to add you.';
  if (code === 'rate_limited' || (e && e.status === 429)) return 'Too many requests. Try again in a minute.';
  if (code === 'already_requested' || (e && e.status === 409)) return 'That\'s already been requested.';
  if (e && e.data && e.data.message) return e.data.message;
  return 'Couldn\'t send the request. Try again.';
}

async function submit(opt, btn) {
  const me = ctx;
  if (!me || me.busy) return;
  me.busy = true;
  showError('');
  const label = btn.querySelector('span:last-child');
  const prev = label ? label.textContent : '';
  btn.disabled = true;
  if (label) label.textContent = 'Requesting…';
  try {
    const r = await requestTitle({ mediaType: me.item.mediaType, tmdbId: me.item.tmdbId, seasons: opt.seasons });
    if (ctx !== me) { me.item.status = r.status; if (me.onStatus) me.onStatus(r.status); toast('Requested — it\'ll appear in MyFlix when it\'s ready'); return; }
    me.state = r.status || 'pending';
    me.item.status = me.state;
    me.done = r.autoApproved ? 'approved' : 'requested';
    if (me.onStatus) me.onStatus(me.state);
    toast('Requested — it\'ll appear in MyFlix when it\'s ready');
    paintStatus();
    paintActions(true);
    focusPrimary();   // the pressed button went disabled; park focus on Close so D-pad / Back keep working
  } catch (e) {
    if (ctx !== me) return;
    if (e && e.status === 409) {   // already requested elsewhere: reflect it instead of offering the button again
      me.state = me.state === 'none' ? 'pending' : me.state;
      me.item.status = me.state;
      if (me.onStatus) me.onStatus(me.state);
      paintStatus();
      paintActions(true);
      focusPrimary();
    } else {
      btn.disabled = false;
      if (label) label.textContent = prev;
      btn.focus({ preventScroll: true });
    }
    if (!(e && (e.status === 401 || (e.status === 403 && e.code === 'profile')))) showError(errorText(e));
  } finally { me.busy = false; }
}

export function openRequest(item, { onStatus } = {}) {
  const root = document.getElementById('modal-root');
  if (!root || !item) return;
  if (layer && !layer.isConnected) hardReset();
  if (layer) return;                       // one sheet at a time
  if (root.firstElementChild) return;      // never stack over the detail modal
  mount(root);

  const me = ctx = {
    item, onStatus, isTv: item.mediaType === 'tv', state: item.status || 'none',
    seasons: null, busy: false, done: null, sig: null,
  };
  layer.setAttribute('aria-label', item.title || 'Request a title');

  const media = el('div', { class: 'dm-hero-media' },
    item.backdrop ? tmdbImgEl(item.backdrop, item.title) : el('div', { class: 'dm-hero-ph' }));
  me.actionsEl = el('div', { class: 'dm-actions rq-actions' });
  const hero = el('div', { class: 'dm-hero rq-hero' }, media,
    el('div', { class: 'dm-hero-content' }, el('h2', { class: 'dm-title rq-title' }, item.title || ''), me.actionsEl));

  const line = el('div', { class: 'dm-line' });
  const score = Number(item.score);
  if (score > 0) line.appendChild(el('span', { class: 'dm-score', title: 'Community rating ' + score.toFixed(1) + '/10' }, '\u2605 ' + score.toFixed(1)));
  if (item.year) line.appendChild(el('span', { class: 'dm-year' }, String(item.year)));
  line.appendChild(el('span', { class: 'badge-rating' }, me.isTv ? 'Series' : 'Movie'));
  me.statusEl = el('p', { class: 'rq-status', role: 'status' });
  me.errEl = el('p', { class: 'rq-err', role: 'alert', hidden: true });
  const body = el('div', { class: 'dm-body rq-body' }, line, me.statusEl, me.errEl,
    item.overview ? el('p', { class: 'dm-overview' }, item.overview) : null);

  box.append(
    el('button', { class: 'dm-close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => closeRequest(), html: icon('close', 20) }),
    hero, body);

  paintStatus();
  paintActions(true);
  store.emit('modal:open', { tmdbId: item.tmdbId });
  focusPrimary();
  setBackgroundInert(true);

  if (me.isTv) {   // per-season state decides which buttons make sense; the sheet is usable meanwhile
    discoverTv(item.tmdbId).then((d) => {
      if (ctx !== me || !d || !Array.isArray(d.seasons)) return;
      me.seasons = d.seasons;
      if (!me.done) { paintStatus(); paintActions(false); }
    }).catch(() => {});
  }
}
