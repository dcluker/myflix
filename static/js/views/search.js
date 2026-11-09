// Search view: instant client-side ranking over the library index (name > word prefix > substring > cast/crew > genre),
// diacritic- and case-insensitive. The query comes from the hash (#/search?q=); the nav search box drives it.
import * as store from '../store.js';
import { el, isTV } from '../util.js';
import { discoverSearch } from '../api.js';
import { makeCards, norm } from './browse.js';
import { openRequest, tmdbImgEl, STATUS_BADGE } from '../components/request.js';

const MAX_CHIPS = 8;
const DISCOVER_DELAY = 450;     // wait for typing to settle before asking Jellyseerr
const DISCOVER_TTL = 120000;    // matches the server cache
const discoverCache = new Map();   // query -> {at, items}

// ---- ranking ---------------------------------------------------------------------------
const fieldCache = new WeakMap();

function split(n) { return n ? n.split(' ') : []; }

function fields(it) {
  let f = fieldCache.get(it);
  if (f) return f;
  const name = norm(it.name);
  f = {
    name,
    words: split(name),
    compact: name.replace(/ /g, ''),
    people: (it.people || []).map((p) => { const n = norm(p); return { raw: p, n, words: split(n) }; }),
    genres: (it.genres || []).map((g) => { const n = norm(g); return { raw: g, n, words: split(n) }; }),
  };
  fieldCache.set(it, f);
  return f;
}

function allPrefix(words, toks) {
  if (!toks.length) return false;
  for (const t of toks) {
    let hit = false;
    for (const w of words) if (w.startsWith(t)) { hit = true; break; }
    if (!hit) return false;
  }
  return true;
}

function personRank(p, q, toks) {
  if (p.n === q) return 340;
  if (p.n.startsWith(q)) return 320;
  if (allPrefix(p.words, toks)) return 300;
  if (p.n.includes(q)) return 280;
  return 0;
}

function rankItem(it, q, toks, qc) {
  const f = fields(it);
  if (f.name === q) return { rank: 1000, why: '' };
  if (f.name.startsWith(q)) return { rank: 900, why: '' };
  if (allPrefix(f.words, toks)) return { rank: 700, why: '' };
  if (f.name.includes(q)) return { rank: 500, why: '' };
  if (qc.length >= 3 && f.compact.includes(qc)) return { rank: 450, why: '' };
  let best = 0;
  let why = '';
  for (const p of f.people) {
    const r = personRank(p, q, toks);
    if (r > best) { best = r; why = p.raw; }
  }
  if (best) return { rank: best, why };
  for (const g of f.genres) {
    if (g.n === q || g.n.startsWith(q) || allPrefix(g.words, toks)) return { rank: 100, why: '' };
  }
  return null;
}

function search(index, q) {
  const toks = split(q);
  const qc = q.replace(/ /g, '');
  const res = [];
  for (const it of index) {
    const r = rankItem(it, q, toks, qc);
    if (r) res.push({ item: it, rank: r.rank, why: r.why });
  }
  res.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    const fa = fields(a.item);
    const fb = fields(b.item);
    if (a.rank >= 450 && fa.name.length !== fb.name.length) return fa.name.length - fb.name.length;
    const sa = a.item.score || 0;
    const sb = b.item.score || 0;
    if (sa !== sb) return sb - sa;
    return fa.name < fb.name ? -1 : fa.name > fb.name ? 1 : 0;
  });
  return res;
}

// ---- "Explore titles related to:" ------------------------------------------------------
function genreHref(g) { return '#/browse?genre=' + encodeURIComponent(g); }
function searchHref(s) { return '#/search?q=' + encodeURIComponent(s); }

function tally(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function topKeys(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

function relatedChips(index, q, toks, results) {
  const chips = [];
  const seen = new Set();
  const add = (label, href) => {
    const k = label.toLowerCase();
    if (chips.length >= MAX_CHIPS || seen.has(k)) return;
    seen.add(k);
    chips.push({ label, href });
  };

  // genres the query itself names
  const genreCount = new Map();
  for (const it of index) for (const g of it.genres || []) tally(genreCount, g);
  for (const g of topKeys(genreCount, genreCount.size)) {
    const n = norm(g);
    if (n === q || n.startsWith(q) || allPrefix(split(n), toks) || (q.length >= 3 && n.includes(q))) add(g, genreHref(g));
  }

  // people the query names (found on the matching titles)
  const people = new Map();
  for (const r of results.slice(0, 60)) {
    for (const p of fields(r.item).people) {
      if (p.n !== q && personRank(p, q, toks) >= 280) tally(people, p.raw);
    }
  }
  for (const p of topKeys(people, 3)) add(p, searchHref(p));

  // genres of the best matches
  const top = new Map();
  for (const r of results.slice(0, 12)) for (const g of r.item.genres || []) tally(top, g);
  for (const g of topKeys(top, 6)) add(g, genreHref(g));
  return chips;
}

function topGenres(index, n) {
  const m = new Map();
  for (const it of index) for (const g of it.genres || []) tally(m, g);
  return topKeys(m, n);
}

// ---- "Not in MyFlix yet" (Jellyseerr) -----------------------------------------------------
function badgeEl(status) {
  const label = STATUS_BADGE[status];
  return label ? el('span', { class: 'rq-badge', 'data-status': status }, label) : null;
}

function syncBadge(card, status) {
  const old = card.querySelector('.rq-badge');
  if (old) old.remove();
  const b = badgeEl(status);
  if (b) card.querySelector('.rq-below').appendChild(b);
  card.setAttribute('aria-label', cardLabel(card._rq));
}

function cardLabel(it) {
  return it.title + (it.year ? ' (' + it.year + ')' : '') + ', ' + (it.mediaType === 'tv' ? 'series' : 'movie')
    + (STATUS_BADGE[it.status] ? ', ' + STATUS_BADGE[it.status].toLowerCase() : ', not in MyFlix yet. Press to request');
}

// data-tmdb / data-media-type (no data-id): hover cards, focus memory and Play/Pause skip these.
function requestCard(it) {
  const cap = el('div', { class: 'bcard-cap' },
    el('div', { class: 'bcard-name' }, it.title),
    el('div', { class: 'bcard-sub' }, [it.year, it.mediaType === 'tv' ? 'Series' : 'Movie'].filter(Boolean).join(' · ')));
  // TMDB posters carry their own title art: the name, year and status go under the poster, never on it
  const box = el('div', { class: 'card-img rq-img' }, tmdbImgEl(it.poster, it.title));
  const badge = badgeEl(it.status);
  const belowEl = el('div', { class: 'rq-below' }, cap, badge);
  const card = el('div', {
    class: 'card rq-card',
    tabindex: '0',
    role: 'button',
    dataset: { tmdb: it.tmdbId, mediaType: it.mediaType },
    onclick: () => openRequest(it, { onStatus: (st) => { it.status = st; syncBadge(card, st); } }),
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
    },
  }, box, belowEl);
  card._rq = it;
  card.setAttribute('aria-label', cardLabel(it));
  return card;
}

// ---- view -------------------------------------------------------------------------------
export function render(container, params = {}) {
  const raw = String(params.q || '').trim();
  const q = norm(raw);
  const cards = makeCards();
  const root = el('div', { class: 'sx' });
  container.appendChild(root);

  // Titles Jellyseerr knows about that the library lacks. Lives below the local results (between the
  // "no matches" message and its suggestions when there are none); hidden until it has something.
  const disc = { items: null, loading: false };
  const reqBox = el('section', { class: 'sx-req', 'aria-label': 'Not in MyFlix yet', hidden: true });
  let closed = false;
  let fetchTimer = 0;
  let noLocal = false;    // no library matches: the request grid is the page's main content
  let keyed = false;      // the user pressed a key since this view mounted
  const onKey = () => { keyed = true; };
  document.addEventListener('keydown', onKey, true);

  let reqSig = null;
  function drawDiscover() {
    const byId = store.get('byId') || new Map();
    const items = (disc.items || []).filter((it) => !(it.jellyfinId && byId.has(it.jellyfinId)));
    const sig = (disc.loading ? 'L' : '') + items.map((it) => it.mediaType + it.tmdbId + it.status).join();
    if (sig === reqSig && reqBox.isConnected) return;   // unchanged: keep the DOM (and D-pad focus) as is
    reqSig = sig;
    reqBox.textContent = '';
    reqBox.hidden = !(disc.loading || items.length);
    if (reqBox.hidden) return;
    reqBox.appendChild(el('h2', { class: 'sx-req-title' }, 'Not in MyFlix yet'));
    if (!items.length) {
      reqBox.appendChild(el('p', { class: 'sx-req-note', role: 'status' }, 'Searching…'));
      return;
    }
    reqBox.appendChild(el('p', { class: 'sx-req-note' }, 'Pick one to request it. It will show up here when it\'s ready.'));
    const grid = el('div', { class: 'bgrid rq-grid' }, items.map(requestCard));
    reqBox.appendChild(grid);
    // TV autofocus already landed on the suggestion chips before this grid existed (it sits above them):
    // with nothing else to look at, hand focus to the first poster until the user presses a key.
    if (noLocal && !keyed && isTV() && root.contains(document.activeElement)) {
      const first = grid.firstElementChild;
      if (first) first.focus({ preventScroll: true });
    }
  }

  function loadDiscover() {
    if (raw.length < 2) return;
    const hit = discoverCache.get(raw.toLowerCase());
    if (hit && Date.now() - hit.at < DISCOVER_TTL) { disc.items = hit.items; drawDiscover(); return; }
    fetchTimer = setTimeout(() => {
      disc.loading = true;
      drawDiscover();
      discoverSearch(raw).then((items) => {
        if (closed) return;   // stale: the query (and this view) moved on
        disc.items = Array.isArray(items) ? items : [];
        discoverCache.set(raw.toLowerCase(), { at: Date.now(), items: disc.items });
        if (discoverCache.size > 30) discoverCache.delete(discoverCache.keys().next().value);
      }).catch(() => { if (!closed) disc.items = []; })
        .finally(() => { if (closed) return; disc.loading = false; drawDiscover(); });
    }, DISCOVER_DELAY);
  }

  function genreChips(label, genres) {
    if (!genres.length) return null;
    return el('div', { class: 'sx-explore' },
      el('span', { class: 'sx-explore-label' }, label),
      genres.map((g) => el('a', { class: 'sx-chip', href: genreHref(g) }, g)));
  }

  function draw() {
    const index = store.get('index') || [];
    root.textContent = '';

    if (!q) {
      root.appendChild(el('div', { class: 'sx-empty' },
        el('h1', null, 'Search for movies, shows, people, or genres.'),
        genreChips('Try a genre:', topGenres(index, MAX_CHIPS))));
      return;
    }

    const results = search(index, q);
    noLocal = !results.length;
    if (!results.length) {
      const genres = topGenres(index, MAX_CHIPS);
      root.appendChild(el('div', { class: 'sx-empty sx-empty--top' },
        el('h1', null, 'Your search for “', el('strong', null, raw), '” did not have any matches.')));
      root.appendChild(reqBox);
      root.appendChild(el('div', { class: 'sx-empty sx-empty--rest' },
        el('p', { class: 'sx-sug-t' }, 'Suggestions:'),
        el('ul', { class: 'sx-sug' },
          el('li', null, 'Try different keywords'),
          el('li', null, 'Looking for a movie or TV show?'),
          el('li', null, 'Try using a movie, TV show title, an actor or director'),
          el('li', null, 'Try a genre, like comedy, romance, sports, or drama')),
        genreChips('Browse by genre:', genres),
        el('p', { class: 'sx-all' }, el('a', { class: 'sx-chip', href: '#/browse' }, 'Browse all titles'))));
      return;
    }

    const sr = el('h1', { class: 'sx-sr' }, 'Search results for ' + raw);
    root.appendChild(sr);
    const chips = relatedChips(index, q, split(q), results);
    if (chips.length) {
      root.appendChild(el('div', { class: 'sx-explore' },
        el('span', { class: 'sx-explore-label' }, 'Explore titles related to:'),
        chips.map((c) => el('a', { class: 'sx-chip', href: c.href }, c.label))));
    }
    const grid = el('div', { class: 'bgrid' });
    const frag = document.createDocumentFragment();
    for (const r of results) frag.appendChild(cards.get(r.item, r.why ? 'with ' + r.why : ''));
    grid.appendChild(frag);
    root.appendChild(grid);
    root.appendChild(reqBox);
  }

  draw();
  drawDiscover();
  loadDiscover();

  const unsubs = [
    store.on('index:updated', () => { draw(); reqSig = null; drawDiscover(); }),
    store.on('item:changed', (d) => { if (d && d.id != null) cards.sync(d.id); }),
  ];
  return () => {
    closed = true;
    clearTimeout(fetchTimer);
    document.removeEventListener('keydown', onKey, true);
    unsubs.forEach((u) => u());
  };
}
