// Image URL helpers + placeholder tiles (never a broken-image icon).
import { el } from './util.js';

const WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1920];
const TYPES = { primary: 'Primary', backdrop: 'Backdrop', logo: 'Logo', thumb: 'Thumb' };

function snap(w) {
  const n = Number(w) || 480;
  for (const x of WIDTHS) if (x >= n) return x;
  return WIDTHS[WIDTHS.length - 1];
}

function pick(item, key) {
  if (!item) return null;
  const own = item.img && item.img[key];
  if (own) return { id: item.id, tag: own };
  // Episodes (and anything carrying seriesImg) fall back to the series art.
  const sImg = item.seriesImg;
  if (sImg && item.seriesId) {
    if (sImg[key]) return { id: item.seriesId, tag: sImg[key] };
  }
  return null;
}

// type: 'Primary' | 'Backdrop' | 'Logo' | 'Thumb' (case-insensitive)
export function imgUrl(item, type, w) {
  const key = String(type || '').toLowerCase();
  if (!TYPES[key]) return null;
  // Logos and backdrops of an episode belong to its series, not the still.
  let hit = null;
  if (item && item.type === 'Episode' && (key === 'backdrop' || key === 'logo')) {
    const s = item.seriesImg && item.seriesImg[key];
    hit = s && item.seriesId ? { id: item.seriesId, tag: s } : null;
  } else {
    hit = pick(item, key);
  }
  if (!hit) return null;
  return `/img/${encodeURIComponent(hit.id)}/${TYPES[key]}?tag=${encodeURIComponent(hit.tag)}&w=${snap(w)}`;
}

export function srcset(item, type, ws = [320, 640, 960, 1280]) {
  const seen = new Set();
  const parts = [];
  for (const w of ws) {
    const s = snap(w);
    if (seen.has(s)) continue;
    seen.add(s);
    const u = imgUrl(item, type, s);
    if (!u) return '';
    parts.push(`${u} ${s}w`);
  }
  return parts.join(', ');
}

function titleOf(item) {
  if (!item) return '';
  return item.type === 'Episode' ? (item.seriesName || item.name || '') : (item.name || '');
}

// Dark gradient tile with the title text. Sized by its parent (100% x 100%).
export function placeholderEl(item, cls = '') {
  return el('div', { class: ('img-ph ' + cls).trim(), role: 'img', 'aria-label': titleOf(item) },
    el('span', null, titleOf(item)));
}

// Big art that shows something immediately: a small (usually already cached) copy underneath and
// the full-size one fading in over it once it has loaded. Returns the nodes to append.
// opts: same as imgEl, plus lo (the small width, default 480).
export function layeredImg(item, type, w, opts = {}) {
  const hi = imgEl(item, type, w, opts);
  if (hi.tagName !== 'IMG') return [hi];
  const lo = imgEl(item, type, opts.lo || 480, { cls: opts.cls, alt: '', eager: true });
  if (lo.tagName !== 'IMG') return [hi];
  lo.classList.add('img-lo');
  lo.setAttribute('aria-hidden', 'true');
  hi.classList.add('img-hi');
  const ready = () => hi.classList.add('is-loaded');
  if (hi.complete && hi.naturalWidth) ready();
  else {
    hi.addEventListener('load', ready, { once: true });
    // A failed full-size load would swap in a placeholder over a perfectly good small copy.
    hi.addEventListener('error', (e) => { e.stopImmediatePropagation(); hi.remove(); }, { once: true, capture: true });
  }
  return [lo, hi];
}

// <img> (or placeholder when there is no art / the load fails).
// opts: {cls, alt, sizes, ws, eager}
export function imgEl(item, type, w, opts = {}) {
  const cls = opts.cls || '';
  const url = imgUrl(item, type, w);
  if (!url) return placeholderEl(item, cls);
  const img = el('img', {
    class: ('img ' + cls).trim(),
    src: url,
    alt: opts.alt != null ? opts.alt : titleOf(item),
    loading: opts.eager ? 'eager' : 'lazy',
    decoding: 'async',
    draggable: 'false',
  });
  if (opts.sizes) {
    const ss = srcset(item, type, opts.ws);
    if (ss) { img.setAttribute('srcset', ss); img.setAttribute('sizes', opts.sizes); }
  }
  img.addEventListener('error', () => {
    if (img.isConnected) img.replaceWith(placeholderEl(item, cls));
  }, { once: true });
  return img;
}
