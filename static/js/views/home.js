// Home, Shows, Movies, New & Popular, My List (params.name picks the page).
import * as store from '../store.js';
import { el, icon, isTV, fmtRuntime, fmtSeasons } from '../util.js';
import { layeredImg, imgUrl } from '../img.js';
import { getHome, playUrl, loadSuggestions, SEASONS } from '../api.js';
import { inSeason } from '../components/seasonal.js';
import { renderRow, buildCard, isMobile } from '../components/rows.js';
import { setNextUpHint } from '../components/hovercard.js';

// ---- session-stable randomness -------------------------------------------------------
const SEED = (Math.random() * 4294967296) >>> 0;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const seeded = (key) => rng((SEED ^ hashStr(key)) >>> 0);

// ---- pure selection helpers (exported for tests) ----------------------------------------
const byAddedDesc = (a, b) => String(b.added || '').localeCompare(String(a.added || ''));
const hasDate = (i) => i.added && String(i.added) >= '2000';

export function similarity(src, it) {
  const sg = new Set(src.genres || []);
  const ig = it.genres || [];
  const shared = ig.filter((g) => sg.has(g)).length;
  if (!shared) return 0;
  const union = sg.size + ig.length - shared;
  let s = shared / union;
  const sp = new Set(src.people || []);
  s += (it.people || []).filter((p) => sp.has(p)).length * 0.25;
  if (src.studio && src.studio === it.studio) s += 0.12;
  if (src.type === it.type) s += 0.08;
  s += (it.score || 0) / 60;
  return s;
}

export function becauseYouWatched(src, pool, limit = 20) {
  return pool
    .filter((i) => i.id !== src.id && !i.played)
    .map((i) => [similarity(src, i), i])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, i]) => i);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function bucketNew(pool, now = Date.now(), maxBuckets = 8, cap = 30) {
  const DAY = 864e5;
  const out = [];
  const idx = new Map();
  for (const it of pool.filter(hasDate).sort(byAddedDesc)) {
    const t = Date.parse(it.added);
    if (!isFinite(t)) continue;
    const age = (now - t) / DAY;
    let key; let label;
    if (age <= 7) { key = 'w'; label = 'New This Week'; }
    else if (age <= 30) { key = 'm'; label = 'New This Month'; }
    else {
      const d = new Date(t);
      key = d.getUTCFullYear() + '-' + d.getUTCMonth();
      label = 'Added in ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    }
    let b = idx.get(key);
    if (!b) {
      if (out.length >= maxBuckets) continue;
      b = { key, label, items: [] };
      idx.set(key, b);
      out.push(b);
    }
    if (b.items.length < cap) b.items.push(it);
  }
  return out;
}

function topGenres(pool, n = 8, min = 4) {
  const counts = new Map();
  for (const it of pool) for (const g of it.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([g]) => g);
}

// ---- hero -------------------------------------------------------------------------------
const heroPicks = new Map(); // page name -> item id (stable per session)

function pickHero(pool, name) {
  const saved = heroPicks.get(name);
  if (saved) { const hit = pool.find((i) => i.id === saved); if (hit) return hit; }
  const tiers = [
    (i) => i.img && i.img.backdrop && i.img.logo && (i.score || 0) >= 6.5,
    (i) => i.img && i.img.backdrop && (i.score || 0) >= 6.5,
    (i) => i.img && i.img.backdrop,
  ];
  let pick = null;
  for (const ok of tiers) {
    const c = pool.filter(ok);
    if (!c.length) continue;
    const fresh = c.filter((i) => !i.played);
    const src = fresh.length ? fresh : c;
    pick = src[Math.floor(Math.random() * src.length)];
    break;
  }
  if (pick) heroPicks.set(name, pick.id);
  return pick;
}

function buildHero(item) {
  const bg = layeredImg(item, 'Backdrop', 1920, { eager: true, sizes: '100vw', ws: [1280, 1920], cls: 'hero-img', alt: '' });
  for (const n of bg) if (n.tagName === 'IMG') n.setAttribute('fetchpriority', 'high');

  const titleText = () => el('h1', { class: 'hero-title' }, item.name);
  const logoUrl = imgUrl(item, 'Logo', 960);
  let title;
  if (logoUrl) {
    title = el('h1', { class: 'hero-logo-wrap', 'aria-label': item.name });
    const logo = el('img', { class: 'hero-logo', src: logoUrl, alt: item.name, decoding: 'async', draggable: 'false' });
    logo.addEventListener('error', () => { if (title.isConnected) title.replaceWith(titleText()); }, { once: true });
    title.append(logo);
  } else {
    title = titleText();
  }

  const info = el('div', { class: 'hero-info' }, title);
  // "Movie · Comedy · 2026 · 1h 39m · PG" (TV layout shows it under the logo).
  const bits = [item.type === 'Series' ? 'Series' : 'Movie', (item.genres || [])[0], item.year,
    item.type === 'Series' ? (item.seasons ? fmtSeasons(item.seasons) : '') : fmtRuntime(item.runtimeMin), item.rating].filter(Boolean);
  if (bits.length > 1) info.append(el('div', { class: 'hero-meta' }, bits.map((b, i) => el('span', null, String(b)))));
  if (item.overview) info.append(el('p', { class: 'hero-syn' }, item.overview));
  info.append(el('div', { class: 'hero-actions' },
    el('a', { class: 'btn-play', href: playUrl(item.id) }, el('span', { html: icon('play', 24) }), 'Play'),
    el('a', { class: 'btn-info', href: '#/title/' + encodeURIComponent(item.id) }, el('span', { html: icon('info', 24) }), 'More Info')));

  const hero = el('section', { class: 'hero', 'aria-label': 'Featured: ' + item.name, dataset: { id: item.id } },
    el('div', { class: 'hero-media' }, ...bg),
    el('div', { class: 'hero-vig' }),
    el('div', { class: 'hero-fade' }),
    info);
  if (item.rating) hero.append(el('span', { class: 'badge-rating edge hero-rating' }, item.rating));
  return hero;
}

// ---- /api/home cache ------------------------------------------------------------------------
let homeCache = null; // {at, uid, data}
function cachedHome() {
  const p = store.get('profile');
  if (homeCache && p && homeCache.uid === p.userId && Date.now() - homeCache.at < 60000) return homeCache.data;
  return null;
}
function fetchHome() {
  const p = store.get('profile');
  const uid = p && p.userId;
  return getHome().then((d) => { if (d) homeCache = { at: Date.now(), uid, data: d }; return d || null; }).catch(() => null);
}

const keyOf = (it) => (it.type === 'Episode' ? it.seriesId : it.id);

function continueItems(data, scope) {
  if (!data) return [];
  const resume = (data.resume || []).filter((i) => i && i.id);
  const nextUp = (data.nextUp || []).filter((i) => i && i.id);
  for (const ep of nextUp) setNextUpHint(ep);
  for (const ep of resume) if (ep.type === 'Episode') setNextUpHint(ep);
  let list = resume.concat(scope === 'Movie' ? [] : nextUp);
  if (scope === 'Movie') list = list.filter((i) => i.type !== 'Episode');
  else if (scope === 'Series') list = list.filter((i) => i.type === 'Episode');
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out.slice(0, 20);
}

// ---- pages ---------------------------------------------------------------------------------------
// Cartoons from 1989 and earlier, plus Cow and Chicken by request. Keep in step with private-home-landing/nick_collection.py.
const OLD_SCHOOL = new Set(['Tom and Jerry', 'The Flintstones', 'Scooby-Doo, Where Are You!', 'The Scooby-Doo Show', 'The Smurfs', 'Looney Tunes', 'Cow and Chicken']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LATE = Symbol('late');

export function render(container, params = {}) {
  const name = ['shows', 'movies', 'new', 'mylist'].includes(params.name) ? params.name : 'home';
  const all = store.get('index') || [];
  const unsubs = [];
  let alive = true;
  const cleanup = () => { alive = false; unsubs.forEach((f) => f()); };

  if (name === 'mylist') { renderMyList(container, all, unsubs); return cleanup; }

  const scope = name === 'shows' ? 'Series' : name === 'movies' ? 'Movie' : null;
  const pool = scope ? all.filter((i) => i.type === scope) : all;
  const kind = scope === 'Series' ? 'shows' : scope === 'Movie' ? 'movies' : '';
  const browseBase = scope === 'Series' ? '#/browse?type=series' : scope === 'Movie' ? '#/browse?type=movie' : '#/browse?';
  const browseGenre = (g) => browseBase + (browseBase.endsWith('?') ? '' : '&') + 'genre=' + encodeURIComponent(g);

  const page = el('div', { class: 'home home--' + name });
  container.appendChild(page);

  if (!pool.length) {
    page.classList.add('home--plain');
    page.append(el('div', { class: 'empty-state' },
      el('h2', null, 'Nothing here yet'),
      el('p', null, name === 'home' ? 'Your library is empty.' : 'No ' + (kind || 'titles') + ' in your library yet.')));
    return cleanup;
  }

  const withHero = name !== 'new';
  let rowsEl;
  if (withHero) {
    const hi = pickHero(pool, name);
    if (hi) page.append(buildHero(hi));
    else page.classList.add('home--plain');
    page.classList.toggle('has-hero', !!hi);
  } else {
    page.classList.add('home--plain');
    page.append(el('h1', { class: 'page-title' }, 'New & Popular'));
  }
  rowsEl = el('div', { class: 'home-rows' });
  page.append(rowsEl);

  const slots = {};
  const slot = (key) => { const d = el('div', { class: 'row-slot', dataset: { slot: key } }); rowsEl.append(d); slots[key] = d; return d; };

  // ---- rows that depend only on the index ----
  let myRow = null;
  const myItems = () => pool.filter((i) => i.favorite).sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name)));
  const paintMyList = () => {
    const favs = myItems();
    if (!favs.length) { slots.mylist.replaceChildren(); myRow = null; return; }
    if (myRow && myRow.isConnected) myRow.updateItems(favs);
    else myRow = renderRow(slots.mylist, { title: 'My List', items: favs, variant: 'landscape', seeAllHref: '#/mylist' });
  };

  // One "Suggested by <name>" row per person who has sent this profile something they have not watched yet.
  const paintSuggestions = () => {
    if (!alive || !slots.sugg) return;
    slots.sugg.replaceChildren();
    const byId = store.get('byId');
    const groups = new Map();
    for (const s of store.get('suggestions') || []) {
      const it = byId && byId.get(s.itemId);
      if (!it || it.played || (scope && it.type !== scope)) continue;
      if (!groups.has(s.from)) groups.set(s.from, { name: s.fromName, items: [], ts: s.ts });
      const g = groups.get(s.from);
      if (!g.items.includes(it)) g.items.push(it);
    }
    for (const g of [...groups.values()].sort((a, b) => b.ts - a.ts)) {
      renderRow(slots.sugg, { title: 'Suggested by ' + g.name, items: g.items, variant: 'landscape' });
    }
  };
  unsubs.push(store.on('suggestions:changed', paintSuggestions));
  if (name !== 'new') loadSuggestions();

  const buildSync = () => {
    if (name === 'new') {
      slot('buckets');
      for (const b of bucketNew(pool)) {
        renderRow(slots.buckets, { title: b.label, items: b.items, variant: 'landscape' });
      }
      return;
    }
    (isTV() ? ['tiles', 'byw', 'continue', 'sugg', 'mylist', ...SEASONS.map((_, n) => 'season' + n), 'recent', 'nick', 'oldschool', 'acclaimed', 'g0', 'g1', 'gems', 'g2', 'g3', 'random', 'g4', 'g5', 'g6', 'g7'] : ['continue', 'sugg', 'mylist', ...SEASONS.map((_, n) => 'season' + n), 'recent', 'nick', 'oldschool', 'byw', 'acclaimed', 'g0', 'g1', 'gems', 'g2', 'g3', 'random', 'g4', 'g5', 'g6', 'g7']).forEach(slot);

    paintMyList();
    paintSuggestions();
    if (isTV()) {
      // Big category tiles under the billboard, like Netflix's TV home screen.
      const gs = topGenres(pool, 8);
      if (gs.length >= 3) {
        slots.tiles.append(el('nav', { class: 'gtiles', 'aria-label': 'Browse by category' },
          [['New & Popular', '#/new'], ...gs.map((g) => [g, browseGenre(g)])].map(([label, href]) =>
            el('a', { class: 'gtile', href }, el('span', null, label)))));
      }
    }

    const recent = pool.filter(hasDate).sort(byAddedDesc).slice(0, 20);
    if (recent.length >= 4) renderRow(slots.recent, { title: 'Recently Added', items: recent, variant: 'landscape', seeAllHref: '#/new' });

    const nick = pool.filter((i) => i.type === 'Series' && (/nick/i.test(i.studio || '') || i.name === 'Doug'))   // Doug started on Nick; its metadata says ABC
      .sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name)));
    if (nick.length >= 3) renderRow(slots.nick, { title: 'Nickelodeon', items: nick, variant: 'landscape' });

    const oldschool = pool.filter((i) => i.type === 'Series' && OLD_SCHOOL.has(i.name))
      .sort((a, b) => (a.year || 0) - (b.year || 0));
    if (oldschool.length >= 3) renderRow(slots.oldschool, { title: 'Old School Cartoons', items: oldschool, variant: 'landscape' });

    const acclaimed = pool.filter((i) => (i.critic || 0) >= 80 || (i.score || 0) >= 7.5)
      .map((i) => [((i.critic ? i.critic / 10 : 0) + (i.score || 0)) / ((i.critic ? 1 : 0) + (i.score ? 1 : 0) || 1), i])
      .sort((a, b) => b[0] - a[0]).slice(0, 20).map(([, i]) => i);
    if (acclaimed.length >= 5) renderRow(slots.acclaimed, { title: 'Critically Acclaimed', items: acclaimed, variant: 'landscape' });

    topGenres(pool).forEach((g, i) => {
      const items = shuffled(pool.filter((it) => (it.genres || []).includes(g)), seeded(name + '|' + g)).slice(0, 20);
      renderRow(slots['g' + i], { title: g, items, variant: 'landscape', seeAllHref: browseGenre(g) });
    });

    const shownAcclaimed = new Set(acclaimed.map((i) => i.id));
    let gems = pool.filter((i) => (i.score || 0) >= 7 && !i.played);
    const fresh = gems.filter((i) => !shownAcclaimed.has(i.id));
    if (fresh.length >= 6) gems = fresh;
    gems = shuffled(gems, seeded(name + '|gems')).slice(0, 20);
    if (gems.length >= 5) renderRow(slots.gems, { title: 'Hidden Gems', items: gems, variant: 'landscape' });

    const pickRandom = () => shuffled(pool, Math.random).slice(0, 20);
    if (pool.length >= 6) {
      const rr = renderRow(slots.random, {
        title: 'Random Picks', items: pickRandom(), variant: 'landscape',
        action: { label: '🎲 Shuffle', title: 'Pick a new set', onClick: () => rr.updateItems(pickRandom()) },
      });
    }
  };

  // ---- rows that need /api/home (Continue Watching, Because you watched) ----
  const fillHome = (data) => {
    if (!alive || !slots.continue) return;
    lastSig = sig(data);
    const items = continueItems(data, scope);
    slots.continue.replaceChildren();
    if (items.length) renderRow(slots.continue, { title: 'Continue Watching', items, variant: 'continue' });

    // One row per season (SEASONS): tagged movies/series from the index plus tagged episodes from /api/home.
    SEASONS.forEach((se, n) => {
      const slotEl = slots['season' + n];
      if (!slotEl) return;
      slotEl.replaceChildren();
      const tagged = pool.filter((i) => inSeason(i, se));
      const rawEps = ((data && data.seasonal) || {})[se.key];
      const eps = scope === 'Movie' || !Array.isArray(rawEps) ? [] : rawEps.filter((i) => i && i.id);
      const row = tagged.concat(eps);
      if (row.length >= 3) renderRow(slotEl, { title: se.title, items: row, variant: 'landscape' });
    });

    slots.byw.replaceChildren();
    const byId = store.get('byId');
    let src = null;
    for (const it of items) {
      const hit = byId.get(keyOf(it));
      if (hit && (!scope || hit.type === scope)) { src = hit; break; }
    }
    if (!src) src = pool.filter((i) => i.played).sort(byAddedDesc)[0] || null;
    if (src) {
      const recs = becauseYouWatched(src, pool);
      if (recs.length >= 5) {
        if (isTV()) renderRow(slots.byw, { title: 'Your Next Watch', items: recs, variant: 'poster', feature: 'Because you watched ' + src.name });
        else renderRow(slots.byw, { title: 'Because you watched ' + src.name, items: recs, variant: 'landscape' });
      }
    }
  };

  // keep My List live when the hover card / detail toggles a favorite
  unsubs.push(store.on('item:changed', (d) => {
    if (alive && d && 'favorite' in d && slots.mylist) paintMyList();
  }));

  // back from the player: progress / next-up changed, so refetch (only repaint when Continue Watching differs,
  // a repaint would drop the TV focus off the card you came back to)
  const sig = (d) => JSON.stringify(continueItems(d || {}, scope).map((i) => [i.id, Math.round(i.playedPct || 0)]));
  let lastSig = null;
  unsubs.push(store.on('player:return', () => {
    homeCache = null;
    fetchHome().then((d) => {
      if (!alive || !d || !slots.continue) return;
      const s = sig(d);
      if (s !== lastSig) { lastSig = s; fillHome(d); }
    });
  }));

  if (name === 'new') { buildSync(); return cleanup; }

  const cached = cachedHome();
  if (cached) {
    buildSync();
    fillHome(cached);
  } else {
    const p = fetchHome();
    Promise.race([p, wait(700).then(() => LATE)]).then((d) => {
      if (!alive) return;
      buildSync();
      if (d === LATE) p.then((late) => fillHome(late));
      else fillHome(d);
    });
  }
  return cleanup;
}

// ---- My List page -------------------------------------------------------------------------------
function renderMyList(container, all, unsubs) {
  const page = el('div', { class: 'home home--plain home--mylist' }, el('h1', { class: 'page-title' }, 'My List'));
  const grid = el('div', { class: 'card-grid', dataset: { shape: isMobile() ? 'poster' : 'landscape' } });
  const empty = el('div', { class: 'empty-state' },
    el('h2', null, 'Your list is empty'),
    el('p', null, 'Add shows and movies with the + button and they will show up here.'),
    el('a', { class: 'btn-play', href: '#/browse' }, 'Browse titles'));
  page.append(grid, empty);
  container.appendChild(page);

  const fill = () => {
    const favs = all.filter((i) => i.favorite).sort((a, b) => String(a.sortName || a.name).localeCompare(String(b.sortName || b.name)));
    const mobile = isMobile();
    grid.dataset.shape = mobile ? 'poster' : 'landscape';
    grid.replaceChildren(...favs.map((i) => buildCard(i, 'landscape', { mobile })));
    grid.hidden = !favs.length;
    empty.hidden = favs.length > 0;
  };
  fill();
  unsubs.push(store.on('item:changed', (d) => { if (d && 'favorite' in d && page.isConnected) fill(); }));
}
