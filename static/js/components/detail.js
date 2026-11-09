// Detail modal ("More Info"). openDetail(id) / closeDetail().
//
// Contract with app.js:
//  - openDetail never touches location. It emits modal:open, and closeDetail emits modal:close.
//  - openDetail resolves right after the shell is on screen (data loads in the background), so
//    the router's "suppressClose" window stays short.
//  - Calling openDetail while a modal is open swaps the content in place (More Like This).
//  - Esc / Back key handling lives in tv.js (single owner); this file only traps Tab.
import * as store from '../store.js';
import { getItem, getSeason, setPlayed, resetPosition, setFavorite, playUrl, getSuggestTargets, sendSuggestion, dismissSuggestions } from '../api.js';
import { imgEl, imgUrl, layeredImg } from '../img.js';
import { el, fmtRuntime, fmtSeasons, icon, toast, isTV } from '../util.js';
import { loadTargets, castMenu, castIcon } from './cast.js';
import { seasonButtons } from './seasonal.js';

const EYE = '<svg class="icon icon-eye" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">'
  + '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  + '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

const TABBABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const EP_COLLAPSE_OVER = 12;   // seasons longer than this show EP_COLLAPSED rows + an expander
const EP_COLLAPSED = 10;

let layer = null;      // .dm-layer
let box = null;        // .dm-box
let ctx = null;        // per-open state
let opener = null;     // element to hand focus back to on close
let offs = [];         // teardown callbacks for document-level listeners
let saved = null;      // body styles to restore on unlock

// ---- small helpers ---------------------------------------------------------------
const ic = (name, size) => el('span', { class: 'dm-ic', html: icon(name, size) });

function landscapeType(it, w) {
  for (const t of ['Backdrop', 'Thumb']) if (imgUrl(it, t, w)) return t;
  return 'Primary';
}

function seasonCountOf(item, d) {
  if (d && Number(d.seasonCount) > 0) return Number(d.seasonCount);
  if (d && Array.isArray(d.seasons)) return d.seasons.length;
  if (item && typeof item.seasons === 'number') return item.seasons;
  return 0;
}

// Community rating as "★ 8.4" (out of 10), the same style the hover card uses.
function matchText(score) { return '\u2605 ' + Number(score).toFixed(1); }

function pctLeft(item) {
  const pct = Number(item && item.playedPct) || 0;
  return pct > 0 && pct < 95 ? pct : 0;   // a watched title that was started again is still resumable
}

function liveFav(id, fallback) {
  const it = (store.get('byId') || new Map()).get(id);
  return !!(it ? it.favorite : fallback);
}

// ---- mount / unmount ---------------------------------------------------------------
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
  return Array.from(layer.querySelectorAll(TABBABLE)).filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0 && !n.closest('[inert]'));
}

function focusPlay() {
  const t = (ctx && ctx.els && ctx.els.play) || (layer && layer.querySelector('.dm-close'));
  if (t) { try { t.focus({ preventScroll: true }); } catch { t.focus(); } }
}

function mount(root) {
  const a = document.activeElement;
  opener = a && a !== document.body && a.isConnected && (document.getElementById('view')?.contains(a) || document.getElementById('nav')?.contains(a)) ? a : null;

  layer = el('div', { class: 'dm-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Title details' });
  box = el('div', { class: 'dm-box' });
  layer.appendChild(box);

  // Close only when both press and release happen on the dim backdrop (not after a text drag).
  let downOnLayer = false;
  layer.addEventListener('mousedown', (e) => { downOnLayer = e.target === layer; });
  layer.addEventListener('click', (e) => { if (e.target === layer && downOnLayer) closeDetail(); downOnLayer = false; });

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
    // Chrome makes scroll containers focusable; on the TV the layer itself can take focus
    // (on open, or after returning from the native player). Bounce that to Play.
    if (e.target === layer || e.target === box) { focusPlay(); return; }
    if (layer.contains(e.target)) return;
    focusPlay();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocusIn);
  offs = [
    () => document.removeEventListener('keydown', onKey, true),
    () => document.removeEventListener('focusin', onFocusIn),
    store.on('item:changed', onChanged),
  ];

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!layer) return;
    layer.classList.add('open');
    if (!layer.contains(document.activeElement) || document.activeElement === layer) focusPlay();
  }));
}

function hardReset() {
  for (const f of offs) { try { f(); } catch {} }
  offs = [];
  if (layer) layer.remove();
  layer = box = ctx = null;
  unlockScroll();
  setBackgroundInert(false);
}

// Returns true if the suggest picker was open (tv.js: Back closes it before the detail card).
export function closeSuggest() {
  if (!ctx || !ctx.sheet) return false;
  const { sheet, trigger } = ctx;
  ctx.sheet = null;
  sheet.remove();
  if (box) box.inert = false;
  const t = trigger && trigger.isConnected ? trigger : (ctx.els && ctx.els.play);
  if (t) { try { t.focus({ preventScroll: true }); } catch { t.focus(); } }
  return true;
}

export function closeDetail() {
  if (!layer) return;
  const back = opener;
  opener = null;
  hardReset();
  if (back && back.isConnected && typeof back.focus === 'function') {
    try { back.focus({ preventScroll: true }); } catch { back.focus(); }
  }
  store.emit('modal:close');
}

// ---- open ------------------------------------------------------------------------------
export function openDetail(id) {
  const root = document.getElementById('modal-root');
  if (!root || !id) return Promise.resolve();

  if (layer && !layer.isConnected) hardReset();
  closeSuggest();
  const fresh = !layer;
  if (fresh) mount(root);
  else layer.scrollTop = 0;

  const seed = (store.get('byId') || new Map()).get(id) || null;
  const me = ctx = {
    id,
    item: seed,
    detail: null,
    fav: !!(seed && seed.favorite),
    played: !!(seed && seed.played),
    seasons: [],
    seasonCache: new Map(),
    curSeason: null,
    firstEp: null,
    expanded: false,
    busy: { fav: false, played: false },
    els: {},
    sim: new Map(),
  };

  box.innerHTML = '';
  me.heroEl = el('div', { class: 'dm-hero' });
  me.bodyEl = el('div', { class: 'dm-body' });
  box.append(
    el('button', { class: 'dm-close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => closeDetail(), html: icon('close', 20) }),
    me.heroEl,
    me.bodyEl);

  if (seed) {
    paintHero(seed);
    paintBody(seed, null);
  } else {
    me.heroEl.appendChild(el('div', { class: 'dm-hero-media' }, el('div', { class: 'dm-hero-ph' })));
    me.heroEl.appendChild(el('div', { class: 'view-loading dm-loading', role: 'status', 'aria-label': 'Loading' }, el('div', { class: 'spinner' })));
  }

  layer.setAttribute('aria-label', (seed && seed.name) || 'Title details');
  store.emit('modal:open', { id });
  focusPlay();
  if (fresh) setBackgroundInert(true);

  getItem(id).then((d) => {
    if (ctx !== me || !d) return;
    me.detail = d;
    me.item = Object.assign({}, seed || {}, d);
    if (!me.busy.fav) me.fav = !!d.favorite;
    if (!me.busy.played) me.played = !!d.played;
    me.seasons = Array.isArray(d.seasons) ? d.seasons : [];
    layer.setAttribute('aria-label', me.item.name || 'Title details');
    const heroWasEmpty = !me.els.play;
    if (heroWasEmpty) {
      me.heroEl.innerHTML = '';
      paintHero(me.item);
    }
    const hadFocusInBody = me.bodyEl.contains(document.activeElement);
    paintBody(me.item, d);
    syncButtons();
    if (hadFocusInBody || heroWasEmpty) focusPlay();
  }).catch((err) => {
    if (ctx !== me) return;
    console.error('[myflix] detail load failed', err);
    if (err && (err.status === 401 || err.status === 403)) return; // api.js is routing to #/profiles
    if (err && err.status === 404) {   // stale id (title removed/re-imported): drop the dead end and refresh the library
      toast('That title is no longer available');
      closeDetail();
      store.emit('library:refresh');
      return;
    }
    me.bodyEl.innerHTML = '';
    me.bodyEl.appendChild(el('div', { class: 'dm-error' },
      el('p', null, 'Could not load this title.'),
      el('button', { class: 'btn-info', type: 'button', onclick: () => openDetail(id) }, 'Try again')));
    if (!me.els.play) me.heroEl.innerHTML = '';
  });
  return Promise.resolve();
}

// ---- back from the player ------------------------------------------------------------------
// Playback happens in the native player (TV) or another tab, and progress / watched / next-up change
// meanwhile. When the page becomes visible again after a play link was followed, reload this title so
// "Play S1:E1" does not replay the episode just finished; home.js does the same for its rows.
let playedAt = 0;
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element && e.target.closest('a[href*="/play/"]');
  if (a) playedAt = Date.now();
}, true);
function backFromPlayer() {
  if (!playedAt || document.visibilityState !== 'visible' || Date.now() - playedAt < 4000) return;
  playedAt = 0;
  store.emit('player:return');
  const me = ctx;
  if (!me) return;
  me.seasonCache.clear();
  me.firstEp = null;
  getItem(me.id).then((d) => {
    if (ctx !== me || !d) return;
    me.detail = d;
    me.item = Object.assign({}, me.item || {}, d);
    me.played = !!d.played;
    me.seasons = Array.isArray(d.seasons) ? d.seasons : [];
    const hadFocusInBody = me.bodyEl.contains(document.activeElement);
    paintBody(me.item, d);
    syncButtons();
    if (hadFocusInBody) focusPlay();
  }).catch(() => {});
}
document.addEventListener('visibilitychange', backFromPlayer);
window.addEventListener('focus', backFromPlayer);

// ---- hero ----------------------------------------------------------------------------------
function playTarget() {
  const d = ctx.detail;
  const item = ctx.item || {};
  if (item.type === 'Series') {
    const ep = (d && d.nextUp) || ctx.firstEp;
    return ep ? { href: playUrl(ep.id), ep } : { href: playUrl(ctx.id), ep: null };
  }
  return { href: playUrl(ctx.id), ep: null };
}

function playLabel() {
  const item = ctx.item || {};
  const { ep } = playTarget();
  if (item.type === 'Series') {
    if (!ep) return 'Play';
    const code = ep.season != null && ep.episode != null ? ` S${ep.season}:E${ep.episode}${ep.episodeEnd > ep.episode ? '-' + ep.episodeEnd : ''}` : '';
    return (pctLeft(ep) ? 'Resume' : 'Play') + code;
  }
  return pctLeft(item) ? 'Resume' : 'Play';
}

function paintHero(item) {
  const me = ctx;
  const hero = me.heroEl;
  hero.innerHTML = '';

  const tvLayout = isTV();
  const heroW = tvLayout ? 1920 : 1280;
  const t = landscapeType(item, heroW);
  const media = el('div', { class: 'dm-hero-media' });
  if (imgUrl(item, t, heroW)) {
    media.append(...layeredImg(item, t, heroW, { sizes: tvLayout ? '100vw' : '(min-width: 900px) 850px, 100vw', ws: tvLayout ? [1280, 1920] : [640, 960, 1280], eager: true, alt: '' }));
  } else {
    media.appendChild(el('div', { class: 'dm-hero-ph' }));
  }

  const titleNode = () => el('h2', { class: 'dm-title' }, item.name || '');
  let head;
  const logo = imgUrl(item, 'Logo', 640);
  if (logo) {
    head = el('img', { class: 'dm-logo', src: logo, alt: item.name || '', draggable: 'false' });
    head.addEventListener('error', () => { if (head.isConnected) { const t2 = titleNode(); head.replaceWith(t2); head = t2; } }, { once: true });
  } else {
    head = titleNode();
  }

  const play = el('a', { class: 'btn-play dm-play', href: playUrl(item.id || me.id), 'data-k': 'play' }, ic('play', 24), el('span', { class: 'dm-play-label' }, 'Play'));
  const fav = el('button', { class: 'btn-circle dm-btn', type: 'button', 'data-k': 'fav', onclick: toggleFav });
  const seen = el('button', { class: 'btn-circle dm-btn', type: 'button', 'data-k': 'seen', html: EYE, onclick: togglePlayed });
  const sug = el('button', { class: 'btn-circle dm-btn', type: 'button', 'data-k': 'suggest', title: 'Suggest to someone', 'aria-label': 'Suggest to someone', html: icon('send', 20), onclick: () => openSuggest(sug) });
  const hw = seasonButtons(me.item || item);
  const mine = (store.get('suggestions') || []).filter((s) => s.itemId === me.id);
  const startOver = el('button', { class: tvLayout ? 'dm-menu-btn dm-startover' : 'btn-info dm-startover', type: 'button', 'data-k': 'startover', hidden: true,
    onclick: () => startOverClick(startOver) }, ic('replay', tvLayout ? 26 : 22), el('span', null, 'Start Over'));
  // Cast to TV (phones and browsers only): sends what Play would play. Hidden until the server says a TV is castable.
  const castBtn = el('button', { class: 'btn-circle dm-btn', type: 'button', 'data-k': 'cast', title: 'Cast to TV', 'aria-label': 'Cast to TV', hidden: true, html: castIcon('cast', 22),
    onclick: () => { const { ep } = playTarget(); castMenu(castBtn, ep ? ep.id : (item.id || me.id)); } });
  if (!tvLayout) loadTargets().then((ts) => { if (ts.length && castBtn.isConnected) castBtn.hidden = false; });
  let actions = el('div', { class: 'dm-actions' }, play, startOver, castBtn, fav, seen, sug, ...hw);
  if (tvLayout) {
    // Netflix-style left-hand menu: round buttons, a big white Play pill, then "Episodes & More" / "More Like This".
    const jump = (sel) => {
      const target = me.bodyEl && me.bodyEl.querySelector(sel);
      if (!target) { toast('Still loading, try again in a moment'); return; }
      try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { layer.scrollTop = target.offsetTop; }
      setTimeout(() => {
        const f = target.querySelector('button, a[href], select, [tabindex="0"]');
        if (f) { try { f.focus({ preventScroll: true }); } catch { f.focus(); } }
      }, 450);
    };
    const menuBtn = (label, ic2, sel) => el('button', { class: 'dm-menu-btn', type: 'button', onclick: () => jump(sel) }, ic(ic2, 26), el('span', null, label));
    actions = el('div', { class: 'dm-actions dm-actions--tv' },
      el('div', { class: 'dm-circles' }, fav, seen, sug, ...hw),
      play,
      startOver,
      item.type === 'Series' ? menuBtn('Episodes & More', 'list', '.dm-eps') : null,
      menuBtn('More Like This', 'grid', '.dm-more'));
  }
  let note = null;
  if (mine.length) {
    const first = mine[0];
    note = el('div', { class: 'dm-sugnote' },
      el('span', { class: 'dm-sugnote-by' }, 'Suggested by ' + [...new Set(mine.map((s) => s.fromName))].join(', ')),
      first.note ? el('span', { class: 'dm-sugnote-msg' }, '\u201c' + first.note + '\u201d') : null,
      el('button', { class: 'dm-sugnote-x', type: 'button', title: 'Remove this suggestion', 'aria-label': 'Remove this suggestion',
        onclick: async () => {
          await dismissSuggestions(mine.map((s) => s.id));
          note.remove();
          const p = me.els && me.els.play;   // the Remove button just vanished: hand focus back to Play
          if (p && p.isConnected) { try { p.focus({ preventScroll: true }); } catch { p.focus(); } }
        } }, 'Remove'));
  }
  me.els = { play, fav, seen, head, startOver };

  const hmeta = tvLayout ? metaLine(item, me.detail) : null;
  const hsyn = tvLayout && item.overview ? el('p', { class: 'dm-hsyn' }, item.overview) : null;
  hero.append(media, el('div', { class: 'dm-hero-content' }, head, hmeta, hsyn, actions, note));
  syncButtons();
}

async function startOverClick(btn) {
  const t = playTarget();
  const id = (t.ep && t.ep.id) || (ctx && ctx.id);
  if (!id) return;
  btn.disabled = true;
  try { await resetPosition(id); }
  catch { btn.disabled = false; toast('Could not start over, try again'); return; }
  location.assign(playUrl(id));
}

function syncButtons() {
  const me = ctx;
  if (!me || !me.els.play) return;
  const { play, fav, seen } = me.els;
  const t = playTarget();
  play.href = t.href;
  const lab = play.querySelector('.dm-play-label');
  if (lab) lab.textContent = playLabel();
  if (me.els.startOver) me.els.startOver.hidden = !pctLeft(t.ep || me.item);

  const favLabel = me.fav ? 'Remove from My List' : 'Add to My List';
  fav.title = favLabel;
  fav.setAttribute('aria-label', favLabel);
  fav.setAttribute('aria-pressed', String(me.fav));
  fav.innerHTML = icon(me.fav ? 'check' : 'plus', 20);

  const isSeries = me.item && me.item.type === 'Series';
  const seenLabel = me.played ? (isSeries ? 'Mark series as unwatched' : 'Mark as unwatched') : (isSeries ? 'Mark series as watched' : 'Mark as watched');
  seen.title = seenLabel;
  seen.setAttribute('aria-label', seenLabel);
  seen.setAttribute('aria-pressed', String(me.played));
  seen.classList.toggle('is-filled', me.played);
}

async function openSuggest(trigger) {
  const me = ctx;
  if (!me || me.sheet || !layer) return;
  const sheet = el('div', { class: 'dm-sug', role: 'dialog', 'aria-label': 'Suggest to' });
  me.sheet = sheet;
  me.trigger = trigger;
  const name = (me.item && me.item.name) || 'this title';
  const list = el('div', { class: 'dm-sug-list' }, el('p', { class: 'dm-sug-msg' }, 'Loading\u2026'));
  const note = el('input', { class: 'dm-sug-note', type: 'text', maxlength: '140', placeholder: 'Add a note (optional)', 'aria-label': 'Note' });
  const send = el('button', { class: 'btn-play dm-sug-send', type: 'button', disabled: '' }, 'Send');
  const cancel = el('button', { class: 'btn-info dm-sug-cancel', type: 'button', onclick: () => closeSuggest() }, 'Cancel');
  sheet.append(el('h3', { class: 'dm-sug-title' }, 'Suggest \u201c' + name + '\u201d to'), list, note, el('div', { class: 'dm-sug-btns' }, send, cancel));
  layer.appendChild(sheet);
  box.inert = true;
  const chosen = new Set();
  const names = new Map();
  send.onclick = async () => {
    if (!chosen.size || send.disabled) return;
    send.disabled = true;
    const picked = [...chosen];
    const text = note.value;
    // Close the box right away (the server takes a few seconds to check the title); the result shows as a message.
    if (ctx === me) closeSuggest();
    toast('Sending\u2026', 1200);
    try {
      const r = await sendSuggestion(me.id, picked, text);
      toast('Suggested to ' + (r.names || picked.map((u) => names.get(u))).join(', '));
    } catch (e) {
      toast(e && e.status === 429 ? 'That is plenty for today. Try again tomorrow.' : 'Could not send the suggestion');
    }
  };
  let targets = [];
  try { targets = await getSuggestTargets(); } catch { targets = null; }
  if (ctx !== me || me.sheet !== sheet) return;
  list.replaceChildren();
  if (!targets || !targets.length) {
    list.append(el('p', { class: 'dm-sug-msg' }, targets ? 'There is no one else to suggest to yet.' : 'Could not load the list.'));
  } else {
    for (const t of targets) {
      names.set(t.userId, t.name);
      const b = el('button', { class: 'dm-sug-chip', type: 'button', 'aria-pressed': 'false' }, t.name);
      b.onclick = () => {
        const on = !chosen.has(t.userId);
        on ? chosen.add(t.userId) : chosen.delete(t.userId);
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('is-on', on);
        send.disabled = !chosen.size;
      };
      list.append(b);
    }
  }
  const first = list.querySelector('button');
  const f = first || cancel;
  try { f.focus({ preventScroll: true }); } catch { f.focus(); }
}

async function toggleFav() {
  const me = ctx;
  if (!me || me.busy.fav) return;
  const next = !me.fav;
  me.busy.fav = true;
  me.fav = next;
  syncButtons();
  try { await setFavorite(me.id, next); }
  catch (e) {
    if (ctx === me) { me.fav = !next; syncButtons(); }
    toast('Could not update My List');
  } finally { me.busy.fav = false; }
}

async function togglePlayed() {
  const me = ctx;
  if (!me || me.busy.played) return;
  const next = !me.played;
  // A whole series flips every episode (337 for South Park) and one stray OK on the remote did
  // exactly that, so a series needs a second press within a few seconds.
  if (me.item && me.item.type === 'Series') {
    const now = performance.now();
    if (!me.seenArmedAt || now - me.seenArmedAt > 4000) {
      me.seenArmedAt = now;
      toast(next ? 'Press again to mark every episode watched' : 'Press again to mark every episode unwatched');
      return;
    }
    me.seenArmedAt = 0;
  }
  me.busy.played = true;
  me.played = next;
  syncButtons();
  try {
    await setPlayed(me.id, next);
    if (ctx === me && me.item && me.item.type === 'Series' && me.curSeason) {
      me.seasonCache.clear();
      loadSeason(me.curSeason, true);
    }
  } catch (e) {
    if (ctx === me) { me.played = !next; syncButtons(); }
    toast('Could not update watched state');
  } finally { me.busy.played = false; }
}

function onChanged(ev) {
  const me = ctx;
  if (!me || !ev) return;
  if (ev.id === me.id) {
    if ('favorite' in ev) me.fav = !!ev.favorite;
    if ('played' in ev) me.played = !!ev.played;
    syncButtons();
  }
  const b = me.sim.get(ev.id);
  if (b && 'favorite' in ev) syncSimBtn(b, !!ev.favorite);
}

// ---- body ----------------------------------------------------------------------------------
function metaLine(item, d) {
  const line = el('div', { class: 'dm-line' });
  const score = Number(item.score);
  if (score > 0) line.appendChild(el('span', { class: 'dm-score', title: 'Community rating ' + score.toFixed(1) + '/10' }, matchText(score)));
  if (item.year) line.appendChild(el('span', { class: 'dm-year' }, String(item.year)));
  if (item.rating) line.appendChild(el('span', { class: 'badge-rating' }, item.rating));
  if (item.type === 'Series') {
    const n = seasonCountOf(item, d);
    if (n > 0) line.appendChild(el('span', { class: 'dm-rt' }, fmtSeasons(n)));
  } else if (item.runtimeMin) {
    line.appendChild(el('span', { class: 'dm-rt' }, fmtRuntime(item.runtimeMin)));
  }
  line.appendChild(el('span', { class: 'badge-hd' }, 'HD'));
  const critic = Number(item.critic);
  if (critic > 0) line.appendChild(el('span', { class: 'dm-critic', title: 'Critic score' }, Math.round(critic) + '% critics'));
  return line;
}

function progressBlock(item, d) {
  let pct = 0;
  let left = 0;
  if (item.type === 'Series') {
    const ep = d && d.nextUp;
    if (ep && pctLeft(ep)) { pct = ep.playedPct; left = ep.runtimeMin ? Math.round(ep.runtimeMin * (1 - pct / 100)) : 0; }
  } else if (pctLeft(item)) {
    pct = item.playedPct;
    left = item.runtimeMin ? Math.round(item.runtimeMin * (1 - pct / 100)) : 0;
  }
  if (!pct) return null;
  return el('div', { class: 'dm-resume' },
    el('div', { class: 'dm-bar' }, el('i', { style: { width: Math.min(100, Math.max(0, pct)) + '%' } })),
    left > 0 ? el('span', null, fmtRuntime(left) + ' left') : null);
}

function fact(label, node) {
  return el('div', { class: 'dm-fact' }, el('span', { class: 'dm-k' }, label + ' '), node);
}

function castFact(names) {
  if (!names.length) return null;
  const SHOW = isTV() ? Infinity : 5;   // the TV has no pointer for "more": list everyone (the server caps it at 20)
  const holder = el('span', { class: 'dm-v' });
  const paint = (all) => {
    holder.innerHTML = '';
    holder.append((all ? names : names.slice(0, SHOW)).join(', '));
    if (!all && names.length > SHOW) {
      holder.append(', ');
      holder.appendChild(el('button', { class: 'dm-more-link', type: 'button', 'data-tv-skip': '', onclick: () => { paint(true); } }, 'more'));
    }
  };
  paint(false);
  return fact('Cast:', holder);
}

function paintBody(item, d) {
  const me = ctx;
  const body = me.bodyEl;
  body.innerHTML = '';
  me.sim = new Map();
  const isSeries = item.type === 'Series';

  // ---- info: two columns -----
  const left = el('div', { class: 'dm-left' }, metaLine(item, d));
  const prog = progressBlock(item, d);
  if (prog) left.appendChild(prog);
  if (d && d.tagline) left.appendChild(el('p', { class: 'dm-tag' }, d.tagline));
  if (item.overview) left.appendChild(el('p', { class: 'dm-overview' }, item.overview));

  const right = el('div', { class: 'dm-right' });
  const castNames = d && Array.isArray(d.cast) && d.cast.length ? d.cast.map((c) => c.name).filter(Boolean) : (item.people || []);
  const cf = castFact(castNames);
  if (cf) right.appendChild(cf);
  const dirs = d && Array.isArray(d.directors) ? d.directors.filter(Boolean) : [];
  if (dirs.length) right.appendChild(fact(dirs.length > 1 ? 'Directors:' : 'Director:', el('span', { class: 'dm-v' }, dirs.join(', '))));
  if (item.genres && item.genres.length) right.appendChild(fact('Genres:', el('span', { class: 'dm-v' }, item.genres.join(', '))));
  const studios = d && Array.isArray(d.studios) && d.studios.length ? d.studios : (item.studio ? [item.studio] : []);
  if (studios.length) right.appendChild(fact('Studio:', el('span', { class: 'dm-v' }, studios.join(', '))));

  // TV: the details are a D-pad stop of their own, so Down from the hero lands on them and scrolls them into view
  // instead of jumping straight past the (non-focusable) text to the first More Like This tile.
  const info = el('div', Object.assign({ class: 'dm-info' }, isTV() ? { class: 'dm-info dm-info--tv', tabindex: '0', 'aria-label': 'Details' } : {}), left, right);
  body.appendChild(info);

  // ---- episodes -----
  if (isSeries) body.appendChild(buildEpisodes(item, d));

  // ---- more like this -----
  const sim = d && Array.isArray(d.similar) ? d.similar.filter((s) => s && s.id !== item.id) : [];
  if (sim.length) {
    body.appendChild(el('section', { class: 'dm-more' },
      el('h3', { class: 'dm-h' }, 'More Like This'),
      el('div', { class: 'dm-grid' }, sim.slice(0, 12).map(simCard))));
  }
}

// ---- episodes ------------------------------------------------------------------------------
function buildEpisodes(item, d) {
  const me = ctx;
  const sec = el('section', { class: 'dm-eps' });
  const list = el('div', { class: 'dm-ep-list', role: 'list' });
  me.listEl = list;

  if (!d) {
    sec.append(el('div', { class: 'dm-eps-head' }, el('h3', { class: 'dm-h' }, 'Episodes')), list);
    paintSkeleton(list);
    return sec;
  }
  const seasons = me.seasons;
  if (!seasons.length) {
    sec.append(el('div', { class: 'dm-eps-head' }, el('h3', { class: 'dm-h' }, 'Episodes')),
      el('p', { class: 'dm-empty' }, 'No episodes available yet.'));
    return sec;
  }

  const next = d.nextUp;
  const start = (next && seasons.find((s) => s.index === next.season)) || seasons.find((s) => s.index >= 1) || seasons[0];
  me.curSeason = me.curSeason && seasons.some((s) => s.id === me.curSeason) ? me.curSeason : start.id;

  const seasonName = (s) => s.name || ('Season ' + s.index);
  let select;
  if (isTV()) {
    // The Fire TV WebView's native <select> popup is unreliable with a D-pad, so the TV gets an in-page picker:
    // a button that opens a list of season buttons (ordinary focus stops, Back closes the list first).
    const wrap = el('div', { class: 'dm-season-wrap' });
    const label = () => seasonName(seasons.find((s) => s.id === me.curSeason) || seasons[0]);
    const btn = el('button', { class: 'dm-select dm-select--tv', type: 'button', 'aria-label': 'Season', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'data-k': 'season' }, label());
    const menu = el('div', { class: 'dm-season-menu', role: 'listbox', hidden: true });
    const close = (refocus) => {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    };
    menu.closeMenu = close;
    seasons.forEach((s) => {
      const b = el('button', { class: 'dm-season-opt', type: 'button', role: 'option', 'aria-selected': String(s.id === me.curSeason), 'data-id': s.id }, seasonName(s));
      b.addEventListener('click', () => {
        me.expanded = false; me.curSeason = s.id; btn.textContent = seasonName(s);
        menu.querySelectorAll('.dm-season-opt').forEach((o) => o.setAttribute('aria-selected', String(o === b)));
        close(true); loadSeason(s.id);
      });
      menu.appendChild(b);
    });
    btn.addEventListener('click', () => {
      if (!menu.hidden) { close(true); return; }
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild).focus();
    });
    wrap.append(btn, menu);
    select = wrap;
  } else {
    select = el('select', { class: 'dm-select', 'aria-label': 'Season', 'data-k': 'season' },
      seasons.map((s) => el('option', { value: s.id, selected: s.id === me.curSeason }, seasonName(s))));
    select.value = me.curSeason;
    select.addEventListener('change', () => { me.expanded = false; me.curSeason = select.value; loadSeason(select.value); });
  }

  sec.append(el('div', { class: 'dm-eps-head' }, el('h3', { class: 'dm-h' }, 'Episodes'), select), list);
  loadSeason(me.curSeason);
  return sec;
}

function paintSkeleton(list) {
  list.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    list.appendChild(el('div', { class: 'dm-ep dm-skel', 'aria-hidden': 'true' },
      el('span', { class: 'dm-ep-num' }),
      el('span', { class: 'dm-ep-thumb' }),
      el('span', { class: 'dm-ep-info' }, el('span', { class: 'dm-skel-line' }), el('span', { class: 'dm-skel-line short' }))));
  }
}

async function loadSeason(seasonId, quiet) {
  const me = ctx;
  if (!me || !me.listEl) return;
  const list = me.listEl;
  if (me.seasonCache.has(seasonId)) { paintEpisodes(me.seasonCache.get(seasonId)); return; }
  if (!quiet) paintSkeleton(list);
  try {
    const eps = await getSeason(me.id, seasonId);
    if (ctx !== me) return;
    const arr = Array.isArray(eps) ? eps : [];
    me.seasonCache.set(seasonId, arr);
    if (!me.firstEp && arr.length) {
      me.firstEp = arr.find((e) => !e.played) || arr[0];
      syncButtons();
    }
    if (me.curSeason === seasonId) paintEpisodes(arr);
  } catch (e) {
    if (ctx !== me || me.curSeason !== seasonId) return;
    if (e && (e.status === 401 || e.status === 403)) return;
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'dm-error' },
      el('p', null, 'Could not load episodes.'),
      el('button', { class: 'btn-info', type: 'button', onclick: () => loadSeason(seasonId) }, 'Try again')));
  }
}

function paintEpisodes(eps) {
  const me = ctx;
  const list = me.listEl;
  if (!list) return;
  list.innerHTML = '';
  if (!eps.length) { list.appendChild(el('p', { class: 'dm-empty' }, 'No episodes in this season.')); return; }
  const nextId = me.detail && me.detail.nextUp ? me.detail.nextUp.id : null;
  const collapse = eps.length > EP_COLLAPSE_OVER && !me.expanded;
  const shown = collapse ? eps.slice(0, EP_COLLAPSED) : eps;
  shown.forEach((ep, i) => list.appendChild(epRow(ep, i, ep.id === nextId)));
  if (collapse) {
    list.appendChild(el('button', {
      class: 'dm-expand', type: 'button',
      'aria-label': `Show all ${eps.length} episodes`, title: `Show all ${eps.length} episodes`,
      onclick: () => { me.expanded = true; paintEpisodes(eps); },
    }, el('span', { class: 'dm-expand-btn', html: icon('caret', 28) })));
  }
}

function epRow(ep, i, isNext) {
  const pct = pctLeft(ep);
  const hasOwn = ep.img && (ep.img.primary || ep.img.thumb);
  const type = hasOwn ? (ep.img.primary ? 'Primary' : 'Thumb') : 'Backdrop';
  const thumb = el('span', { class: 'dm-ep-thumb' },
    imgEl(ep, type, 320, { sizes: '(min-width: 600px) 136px, 96px', ws: [160, 320, 480], alt: '' }),
    el('span', { class: 'dm-ep-play', html: icon('play', 22) }));
  if (ep.played) thumb.appendChild(el('span', { class: 'dm-ep-seen', title: 'Watched', html: icon('check', 14) }));
  if (pct) thumb.appendChild(el('span', { class: 'dm-ep-prog' }, el('i', { style: { width: pct + '%' } })));
  const rt = ep.runtimeMin ? fmtRuntime(ep.runtimeMin) : '';
  let epCast = null;
  if (!isTV()) {
    epCast = el('button', { class: 'dm-ep-cast', type: 'button', title: 'Cast this episode to a TV', 'aria-label': 'Cast this episode to a TV', hidden: true, html: castIcon('cast', 20),
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); castMenu(epCast, ep.id); } });
    loadTargets().then((ts) => { if (ts.length) epCast.hidden = false; });
  }
  return el('a', { class: 'dm-ep' + (isNext ? ' is-next' : ''), href: playUrl(ep.id), role: 'listitem', 'data-id': ep.id },
    el('span', { class: 'dm-ep-num' }, ep.episode != null ? ep.episode + (ep.episodeEnd > ep.episode ? '-' + ep.episodeEnd : '') : String(i + 1)),
    thumb,
    el('span', { class: 'dm-ep-info' },
      el('span', { class: 'dm-ep-head' },
        el('span', { class: 'dm-ep-name' }, ep.name || ('Episode ' + (i + 1))),
        rt ? el('span', { class: 'dm-ep-rt' }, rt) : null,
        epCast),
      ep.overview ? el('span', { class: 'dm-ep-ov' }, ep.overview) : null));
}

// ---- More Like This ---------------------------------------------------------------------------
function syncSimBtn(b, on) {
  b.dataset.on = on ? '1' : '';
  b.innerHTML = icon(on ? 'check' : 'plus', 18);
  const lab = on ? 'Remove from My List' : 'Add to My List';
  b.title = lab;
  b.setAttribute('aria-label', lab);
  b.setAttribute('aria-pressed', String(on));
}

function simCard(it) {
  const me = ctx;
  const href = '#/title/' + encodeURIComponent(it.id);
  const t = landscapeType(it, 480);
  const media = el('a', { class: 'dm-sim-media', href, 'aria-label': it.name || '' },
    imgEl(it, t, 480, { sizes: '(min-width: 900px) 260px, 45vw', ws: [320, 480, 640], alt: '' }),
    el('span', { class: 'dm-sim-title' }, it.name || ''));

  const add = el('button', { class: 'btn-circle dm-sim-add', type: 'button' });
  syncSimBtn(add, liveFav(it.id, it.favorite));
  me.sim.set(it.id, add);
  add.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (add.dataset.busy) return;
    const next = !add.dataset.on;
    add.dataset.busy = '1';
    syncSimBtn(add, next);
    try { await setFavorite(it.id, next); }
    catch { syncSimBtn(add, !next); toast('Could not update My List'); }
    finally { delete add.dataset.busy; }
  });

  const score = Number(it.score);
  const meta = el('div', { class: 'dm-sim-meta' },
    el('div', { class: 'dm-sim-line' },
      score > 0 ? el('span', { class: 'dm-score', title: 'Community rating ' + score.toFixed(1) + '/10' }, matchText(score)) : null,
      it.rating ? el('span', { class: 'badge-rating' }, it.rating) : null,
      it.year ? el('span', { class: 'dm-year' }, String(it.year)) : null,
      it.type === 'Movie' && it.runtimeMin ? el('span', { class: 'dm-year' }, fmtRuntime(it.runtimeMin)) : null),
    add);
  const card = el('article', { class: 'dm-sim', 'data-id': it.id }, media, el('div', { class: 'dm-sim-body' }, meta,
    it.overview ? el('p', { class: 'dm-sim-ov' }, it.overview) : null));
  // Whole card is clickable; the anchor + add button are the only tab stops.
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    media.click();
  });
  return card;
}
