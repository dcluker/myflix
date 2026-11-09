// Content rows: poster / landscape / top10 / continue variants, paddles, page indicators,
// responsive cards-per-view (CSS --cpv) and native scroll-snap on mobile.
import { el, icon, isTV } from '../util.js';
import { imgEl, imgUrl, placeholderEl } from '../img.js';
import { playUrl } from '../api.js';

const MQ_MOBILE = '(max-width: 739px)';
const VARIANTS = ['poster', 'landscape', 'top10', 'continue'];

export function isMobile() {
  try { return !isTV() && window.matchMedia(MQ_MOBILE).matches; } catch { return false; }
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- shared item helpers (also used by hovercard.js / home.js) ----------------
export function titleTarget(item) {
  return item && item.type === 'Episode' && item.seriesId ? item.seriesId : item.id;
}
export function openTitle(item) {
  location.hash = '#/title/' + encodeURIComponent(titleTarget(item));
}
export function playItem(item) {
  location.assign(playUrl(item.id));
}
export function epLabel(ep) {
  if (!ep || ep.season == null || ep.episode == null) return '';
  return 'S' + ep.season + ':E' + ep.episode + (ep.episodeEnd > ep.episode ? '-' + ep.episodeEnd : '');
}
// 16:9 art for an item (episodes use their still, titles their backdrop).
export function landscapeUrl(item, w) {
  if (!item) return null;
  if (item.type === 'Episode') {
    return imgUrl(item, 'Primary', w) || imgUrl(item, 'Backdrop', w) || imgUrl(item, 'Thumb', w);
  }
  return imgUrl(item, 'Backdrop', w) || imgUrl(item, 'Thumb', w);
}

function cardShape(variant, mobile) {
  if (variant === 'top10') return 'top10';
  if (variant === 'poster' || variant === 'continue') return 'poster';
  if (variant === 'landscape' && mobile) return 'poster';
  return 'landscape';
}

function art(item, w, cls, opts = {}) {
  const url = landscapeUrl(item, w);
  if (!url) return placeholderEl(item, cls);
  const img = el('img', {
    class: ('img ' + cls).trim(), src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false',
  });
  if (opts.srcset) {
    const parts = opts.srcset.map((sw) => { const u = landscapeUrl(item, sw); return u ? u + ' ' + sw + 'w' : null; }).filter(Boolean);
    if (parts.length > 1) { img.setAttribute('srcset', parts.join(', ')); img.setAttribute('sizes', opts.sizes || '20vw'); }
  }
  img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(placeholderEl(item, cls)); }, { once: true });
  return img;
}

function rankSvg(rank) {
  const two = rank >= 10;
  const vb = two ? '0 0 150 150' : '0 0 84 150';
  const len = two ? 144 : 80;
  const x = two ? 3 : 2;
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">` +
    `<text x="${x}" y="134" textLength="${len}" lengthAdjust="spacingAndGlyphs" font-size="165" font-weight="800" ` +
    `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" fill="#141414" stroke="#7a7a7a" stroke-width="3.5" ` +
    `stroke-linejoin="round" paint-order="stroke">${rank}</text></svg>`;
}

// Episodes carry the series poster in seriesImg; never show the episode still where a poster is wanted.
function posterOf(item) {
  if (item.type !== 'Episode' || !item.seriesId || !(item.seriesImg && item.seriesImg.primary)) return item;
  return { id: item.seriesId, type: 'Series', name: item.seriesName || item.name, img: { primary: item.seriesImg.primary } };
}

// One card. opts: {mobile, rank}
export function buildCard(item, variant = 'landscape', opts = {}) {
  const mobile = opts.mobile != null ? opts.mobile : isMobile();
  const shape = cardShape(variant, mobile);
  const isEp = item.type === 'Episode';
  const label = isEp ? [item.seriesName, epLabel(item), item.name].filter(Boolean).join(', ') : (item.name || '');
  const card = el('div', {
    class: 'card card--' + shape + (variant === 'continue' ? ' card--continue' : ''),
    tabindex: '0', role: 'link', 'aria-label': label,
    dataset: { id: item.id, variant, shape },
  });
  card._item = item;
  if (isEp && item.seriesId) card.dataset.seriesId = item.seriesId;

  let media;
  let below = null;
  if (shape === 'top10') {
    const poster = el('div', { class: 'card-img' }, imgEl(item, 'Primary', 320, { sizes: '14vw', ws: [240, 320, 480] }));
    card.append(el('div', { class: 't10-num', html: rankSvg(opts.rank || 1) }), poster);
    media = poster;
  } else if (shape === 'poster') {
    media = el('div', { class: 'card-img' }, imgEl(posterOf(item), 'Primary', 320, { sizes: '(max-width:739px) 30vw, 14vw', ws: [240, 320, 480] }));
    card.append(media);
  } else {
    media = el('div', { class: 'card-img has-grad' });
    media.append(art(item, 480, '', { srcset: [320, 480, 640], sizes: '(max-width:739px) 44vw, (max-width:1099px) 25vw, 17vw' }));
    const logoUrl = !isEp ? imgUrl(item, 'Logo', 240) : null;
    const caption = () => {
      const bits = isEp
        ? [el('span', { class: 'cap-ep' }, epLabel(item)), el('span', { class: 'cap-name' }, item.name || '')]
        : [el('span', { class: 'cap-name' }, item.name || '')];
      return el('div', { class: 'card-cap' + (isEp ? ' card-cap--below' : '') }, bits);
    };
    if (logoUrl) {
      const logo = el('img', { class: 'card-logo', src: logoUrl, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      logo.addEventListener('error', () => { if (logo.isConnected) logo.replaceWith(caption()); }, { once: true });
      media.append(logo);
    } else if (isEp) {
      below = caption();   // "S1:E1 Name" goes under the still, not over it
    } else {
      media.append(caption());
    }
    if (variant === 'continue') {
      media.append(el('span', { class: 'card-play', html: icon('play', 22) }));
    }
    card.append(media);
  }

  const pct = Number(item.playedPct) || 0;
  if (pct > 0 && pct < 100) {
    card.append(el('div', { class: 'card-progress', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      el('span', { style: { width: Math.max(2, Math.min(100, pct)) + '%' } })));
  }
  if (below) card.append(below);

  card.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    openTitle(item);
  });
  card.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
  });
  return card;
}

// ---- animated scroll -----------------------------------------------------------
function cancelAnim(track) {
  if (track._raf) { cancelAnimationFrame(track._raf); track._raf = 0; }
}
function animateTo(track, to, dur = 700) {
  cancelAnim(track);
  const from = track.scrollLeft;
  const dist = to - from;
  if (Math.abs(dist) < 1) return;
  if (reducedMotion() || dur <= 0) { track.scrollLeft = to; return; }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    track.scrollLeft = from + dist * e;
    track._raf = p < 1 ? requestAnimationFrame(tick) : 0;
  };
  track._raf = requestAnimationFrame(tick);
}

// ---- the row ---------------------------------------------------------------------
// opts: {title, items, variant, seeAllHref, action:{label, title, onClick}}
// The returned element has .updateItems(items) to swap the cards in place.
export function renderRow(container, opts = {}) {
  const { title = '', seeAllHref, action } = opts;
  const variant = VARIANTS.includes(opts.variant) ? opts.variant : 'landscape';
  let list = Array.isArray(opts.items) ? opts.items.slice() : [];
  if (variant === 'top10') list = list.slice(0, 10);
  let mobile = isMobile();

  const titleEl = el('h2', { class: 'row-title' }, el('span', { class: 'row-title-text' }, title));
  if (seeAllHref) {
    titleEl.append(el('a', { class: 'row-more', href: seeAllHref, 'aria-label': 'Explore all ' + title },
      el('span', null, 'Explore All'), el('span', { class: 'row-more-chev', html: icon('right', 14) })));
  }
  let actionBtn = null;
  if (action && typeof action.onClick === 'function') {
    actionBtn = el('button', { class: 'row-action', type: 'button', title: action.title || action.label, onclick: action.onClick }, action.label);
    titleEl.append(actionBtn);
  }
  const pager = el('ul', { class: 'row-pager', 'aria-hidden': 'true' });
  const head = el('div', { class: 'row-head' }, titleEl, pager);

  const track = el('div', { class: 'row-track no-scrollbar', role: 'list' });
  const prev = el('button', { class: 'paddle paddle-prev is-off', type: 'button', tabindex: '-1', 'data-tv-skip': '', 'aria-label': 'Previous titles', html: icon('left', 32) });
  const next = el('button', { class: 'paddle paddle-next is-off', type: 'button', tabindex: '-1', 'data-tv-skip': '', 'aria-label': 'Next titles', html: icon('right', 32) });
  const slider = el('div', { class: 'row-slider' }, prev, track, next);

  const row = el('section', { class: 'row row--' + variant, dataset: { variant, shape: cardShape(variant, mobile) } }, head, slider);
  row.setAttribute('aria-label', title);

  // -- paging maths --
  let pages = 1;
  let perPage = 1;
  let pageW = 0;
  let maxScroll = 0;
  let dots = [];

  function measure() {
    const first = track.firstElementChild;
    const n = track.children.length;
    if (!first || !n) { pages = 1; pageW = 0; maxScroll = 0; return; }
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const step = (parseFloat(getComputedStyle(first).width) || first.offsetWidth) + gap;
    const cpv = parseFloat(getComputedStyle(row).getPropertyValue('--cpv')) || 6;
    perPage = Math.max(1, Math.floor(cpv + 0.01));
    pageW = step * perPage;
    maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    pages = maxScroll > 2 ? Math.max(2, Math.ceil(n / perPage)) : 1;
  }
  function pageIndex() {
    const sl = track.scrollLeft;
    if (sl >= maxScroll - 2) return pages - 1;
    return Math.max(0, Math.min(pages - 1, Math.round(sl / (pageW || 1))));
  }
  function sync() {
    const sl = track.scrollLeft;
    prev.classList.toggle('is-off', pages < 2 || sl <= 2);
    next.classList.toggle('is-off', pages < 2 || sl >= maxScroll - 2);
    if (dots.length !== (pages > 1 ? pages : 0)) {
      pager.replaceChildren();
      dots = [];
      if (pages > 1) for (let i = 0; i < pages; i++) { const li = el('li'); dots.push(li); pager.append(li); }
    }
    const idx = pageIndex();
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
  }
  function layout() { measure(); sync(); }
  function go(dir) {
    measure();
    if (pages < 2) return;
    const idx = pageIndex();
    const to = Math.max(0, Math.min(maxScroll, (idx + dir) * pageW));
    animateTo(track, to);
  }
  prev.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); go(1); });

  let ticking = false;
  track.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; sync(); });
  }, { passive: true });
  for (const evt of ['wheel', 'touchstart', 'pointerdown']) track.addEventListener(evt, () => cancelAnim(track), { passive: true });

  // Keep a focused card (D-pad / keyboard / Tab) fully inside the gutters.
  function reveal(card, instant) {
    const cs = getComputedStyle(track);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const sl = track.scrollLeft;
    const left = card.offsetLeft;
    const w = parseFloat(getComputedStyle(card).width) || card.offsetWidth;
    let to = null;
    if (left < sl + padL - 1) to = left - padL;
    else if (left + w > sl + track.clientWidth - padR + 1) to = left + w - (track.clientWidth - padR);
    if (to == null) return;
    to = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, to));
    if (instant) { cancelAnim(track); track.scrollLeft = to; }
    else animateTo(track, to, 300);
  }
  track.addEventListener('focusin', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (card && card.parentNode === track) reveal(card, false);
  });
  // tv.js asks rows to reveal the focused card before it scrolls things itself; doing it
  // synchronously keeps its own fallback from jumping the row.
  track.addEventListener('tv:reveal', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (card && card.parentNode === track) reveal(card, true);
  });

  function paint() {
    row.dataset.shape = cardShape(variant, mobile);
    // Feature rows (TV "Your Next Watch"): a big landscape card first, then posters.
    const feat = !!opts.feature && !mobile;
    row.classList.toggle('row--feature', feat);
    track.replaceChildren(...list.map((it, i) => buildCard(it, feat && i === 0 ? 'landscape' : variant, { mobile, rank: i + 1 })));
    if (feat && track.firstElementChild) {
      const big = track.firstElementChild;
      big.classList.add('card--feature');
      const note = typeof opts.feature === 'string' ? opts.feature : '';
      // the "Because you watched X" note sits in the row header, never on the artwork
      const t = row.querySelector('.row-title-text');
      if (t) {
        t.parentElement.querySelector('.row-sub')?.remove();
        if (note) t.after(el('span', { class: 'row-sub' }, note));
      }
    }
    track.scrollLeft = 0;
    row.classList.toggle('is-empty', list.length === 0);
    requestAnimationFrame(layout);
  }

  row.updateItems = (items) => {
    list = Array.isArray(items) ? items.slice() : [];
    if (variant === 'top10') list = list.slice(0, 10);
    cancelAnim(track);
    paint();
  };

  // Responsive: swap poster/landscape art at the mobile breakpoint, recompute paging on resize.
  try {
    const mq = window.matchMedia(MQ_MOBILE);
    const onMq = () => {
      if (!row.isConnected) { mq.removeEventListener('change', onMq); return; }
      const m = isMobile();
      if (m !== mobile) { mobile = m; paint(); }
    };
    mq.addEventListener('change', onMq);
  } catch {}
  if (typeof ResizeObserver === 'function') {
    let t = 0;
    const ro = new ResizeObserver(() => {
      if (!row.isConnected) { ro.disconnect(); return; }
      cancelAnimationFrame(t);
      t = requestAnimationFrame(layout);
    });
    ro.observe(track);
  } else {
    window.addEventListener('resize', () => requestAnimationFrame(layout));
  }

  container.appendChild(row);
  paint();
  return row;
}
