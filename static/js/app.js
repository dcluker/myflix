// Boot + hash router.
import * as store from './store.js';
import { getMe, getIndex } from './api.js';
import { renderNav } from './nav.js';
import { initTV } from './components/tv.js';
import { initHoverCards } from './components/hovercard.js';
import { openDetail, closeDetail } from './components/detail.js';
import { initTheme, initSecondary, themeDefaults } from './theme.js';
import { isTV, isTouch, parseHash, toast, el } from './util.js';
import { prepareIntro } from './intro.js';
import { initHandoff } from './components/handoff.js';

const root = document.documentElement;
if (isTV()) root.classList.add('tv');
if (isTouch()) root.classList.add('touch');
if (/MyFlixApp.* iOS/.test(navigator.userAgent || '')) root.classList.add('app-ios');   // native iPhone/iPad shell: tablet sizing in rows.css/browse.css

const viewEl = document.getElementById('view');

const intro = prepareIntro();   // black overlay now; the animation starts once the first screen is drawn behind it

const LOADERS = {
  home: () => import('./views/home.js'),
  shows: () => import('./views/home.js'),
  movies: () => import('./views/home.js'),
  new: () => import('./views/home.js'),
  mylist: () => import('./views/home.js'),
  browse: () => import('./views/browse.js'),
  live: () => import('./views/live.js'),
  settings: () => import('./views/settings.js'),
  search: () => import('./views/search.js'),
  profiles: () => import('./views/profiles.js'),
};

let booted = false;
let mountToken = 0;
let cleanup = null;
let mountedKey = null;      // hash of the view currently on screen
let base = null;            // {hash, idx} of the last non-title route (what a modal returns to)
let lastIdx = 0;            // history position (stamped into history.state)
let detailOpen = false;
let suppressClose = false;  // true while we ourselves are opening/closing the modal
let lastScrollY = 0;
const scrollMem = new Map();

// ---- history position tracking (so closing a modal can return to the prior hash) ----
function currentIdx() {
  const s = history.state;
  if (s && typeof s.mfIdx === 'number') return s.mfIdx;
  const i = lastIdx + 1;
  try { history.replaceState({ mfIdx: i }, ''); } catch {}
  return i;
}

// ---- index loading ------------------------------------------------------------
let indexFor = null;
let indexAt = 0;
let indexPromise = null;
let indexPromiseFor = null;

function ensureIndex(force = false) {
  const p = store.get('profile');
  if (!p) return Promise.resolve();
  const uid = p.userId;
  if (!force && indexFor === uid && store.get('index')) return Promise.resolve();
  if (!force && indexPromise && indexPromiseFor === uid) return indexPromise;
  indexPromiseFor = uid;
  const pr = getIndex({ refresh: force }).then((data) => {
    const cur = store.get('profile');
    if (!cur || cur.userId !== uid) return;
    store.set('index', Array.isArray(data) ? data : []);
    indexFor = uid;
    indexAt = Date.now();
  }).finally(() => { if (indexPromise === pr) indexPromise = null; });
  indexPromise = pr;
  return pr;
}

function indexReady() {
  const p = store.get('profile');
  return !!(p && indexFor === p.userId && store.get('index'));
}

// ---- view mounting ------------------------------------------------------------
function loadingEl() {
  return el('div', { class: 'view-loading', role: 'status', 'aria-label': 'Loading' }, el('div', { class: 'spinner' }));
}

function errorEl(msg, retry) {
  return el('div', { class: 'view-error' },
    el('h2', null, 'Something went wrong'),
    el('p', null, msg || 'Please try again.'),
    el('button', { class: 'btn-play', type: 'button', onclick: retry }, 'Try again'));
}

async function mountView(r, back = false) {
  const token = ++mountToken;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  mountedKey = r.hash;
  document.body.dataset.route = r.name;
  viewEl.dataset.route = r.name;
  viewEl.innerHTML = '';
  window.scrollTo(0, 0);
  lastScrollY = 0;
  try {
    if (r.name !== 'profiles' && !indexReady()) {
      viewEl.appendChild(loadingEl());
      await ensureIndex();
      if (token !== mountToken) return;
      viewEl.innerHTML = '';
    }
    const mod = await LOADERS[r.name]();
    if (token !== mountToken) return;
    const c = await mod.render(viewEl, r.params);
    if (token !== mountToken) { if (typeof c === 'function') { try { c(); } catch {} } return; }
    cleanup = typeof c === 'function' ? c : null;
    if (back && scrollMem.has(r.hash)) {
      const y = scrollMem.get(r.hash);
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  } catch (e) {
    if (token !== mountToken) return;
    if (parseHash().name === 'profiles' && r.name !== 'profiles') return; // api bounced us to re-link
    console.error('[myflix] view failed', r.name, e);
    viewEl.innerHTML = '';
    viewEl.appendChild(errorEl(e && e.message, () => { mountedKey = null; route(); }));
  }
}

async function openTitle(id) {
  detailOpen = true;
  suppressClose = true;
  try { await openDetail(id); }
  catch (e) { console.error('[myflix] openDetail failed', e); toast('Could not open that title (' + String((e && e.message) || e).slice(0, 80) + ')'); try { closeDetail(); } catch {} }
  finally { suppressClose = false; }
}

function closeModalQuietly() {
  if (!detailOpen) return;
  suppressClose = true;
  try { closeDetail(); } catch (e) { console.error(e); }
  suppressClose = false;
  detailOpen = false;
}

// ---- router -------------------------------------------------------------------
async function route() {
  if (!booted) return;
  const r = parseHash();
  const idx = currentIdx();
  const back = idx < lastIdx;
  lastIdx = idx;
  store.emit('route', { name: r.name, params: r.params, hash: r.hash });

  const profile = store.get('profile');
  if (!profile && r.name !== 'profiles') { location.replace('#/profiles'); return; }

  if (r.name === 'title') {
    if (mountedKey === null) await mountView(parseHash('#/')); // direct link: put home underneath
    await openTitle(r.params.id);
    return;
  }

  if (detailOpen) closeModalQuietly();
  base = { hash: r.hash, idx };
  if (mountedKey === r.hash) { // same view already on screen (e.g. modal just closed)
    if (lastScrollY && Math.abs(window.scrollY - lastScrollY) > 2) window.scrollTo(0, lastScrollY);
    return;
  }
  if (mountedKey) scrollMem.set(mountedKey, lastScrollY);
  await mountView(r, back);
}

store.on('modal:open', () => { detailOpen = true; });
store.on('modal:close', () => {
  detailOpen = false;
  if (suppressClose) return;
  if (lastScrollY && Math.abs(window.scrollY - lastScrollY) > 2) window.scrollTo(0, lastScrollY);
  if (parseHash().name !== 'title') return;
  // Return to whatever the modal was opened over.
  if (base && base.idx < lastIdx) history.go(base.idx - lastIdx);
  else location.replace(base ? base.hash : '#/');
});

function applyProfileTheme() {
  const d = themeDefaults(store.get('me'), (store.get('profile') || {}).userId);
  initTheme(d.accent);
  initSecondary(d.secondary);
}
store.on('profile:changed', applyProfileTheme);

store.on('profile:changed', () => {
  if (!booted) return;
  indexFor = null;
  const r = parseHash();
  if (r.name === 'profiles') return; // the profiles view drives its own navigation
  mountedKey = null;
  base = null;
  if (r.name === 'title') { location.replace('#/'); return; }
  route();
});

store.on('library:refresh', async () => {
  try {
    await ensureIndex(true);
    toast('Library refreshed');
    const r = parseHash();
    if (r.name !== 'title' && r.name !== 'profiles') { mountedKey = null; route(); }
  } catch { toast('Could not refresh the library'); }
});

window.addEventListener('scroll', () => { if (!detailOpen) lastScrollY = window.scrollY; }, { passive: true });
window.addEventListener('hashchange', route);

// Quietly refresh a stale index when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !booted || !store.get('profile')) return;
  if (!indexAt || Date.now() - indexAt < 10 * 60 * 1000) return;
  indexAt = Date.now();
  getIndex().then((data) => { if (Array.isArray(data)) store.set('index', data); }).catch(() => {});
});

// ---- boot ---------------------------------------------------------------------
async function boot() {
  renderNav(document.getElementById('nav'));
  initTV();
  initHoverCards(viewEl);

  let me;
  try {
    me = await getMe();
    initTheme(me && me.theme ? me.theme.accent : null);
    initSecondary(me && me.theme ? me.theme.secondary : null);
  } catch (e) {
    console.error('[myflix] /api/me failed', e);
    viewEl.innerHTML = '';
    intro.cancel();
    viewEl.appendChild(errorEl('Could not reach MyFlix. Retrying…', () => location.reload()));
    const b = viewEl.querySelector('button');
    if (b) { try { b.focus({ preventScroll: true }); } catch {} }
    // The media server (or the network) blips; recover without anyone touching the remote.
    setTimeout(() => location.reload(), 8000);
    return;
  }
  store.set('me', me);

  // Validate the remembered profile against what the server still has linked.
  const saved = store.get('profile');
  const found = saved && (me.profiles || []).find((p) => p.userId === saved.userId);
  store.set('profile', found ? { userId: found.userId, name: found.name, imageUrl: found.imageUrl || null } : null);
  applyProfileTheme();

  const h0 = parseHash();
  // On the TV, ask "Who's watching?" at every app launch (like Netflix) when there is more than one account to
  // pick from. sessionStorage lasts for the app's lifetime, so coming back from the player never re-asks.
  let askWho = false;
  try { askWho = isTV() && !sessionStorage.getItem('mf_picked') && ((me.profiles || []).length + (me.others || []).length) > 1; } catch {}
  if ((askWho || !store.get('profile')) && h0.name !== 'profiles') history.replaceState(history.state, '', '#/profiles');

  booted = true;
  if (!isTV()) initHandoff();
  await route();
  setTimeout(intro.start, 500);   // let the first screen's images settle, then play the intro on an idle page
}

boot();
