// Season buttons (one per SEASONS entry): add/remove a season Genre on a movie, series or episode.
// Admin only (hidden otherwise; the server checks too).
import { el, toast, isTV } from '../util.js';
import { SEASONS, isAdmin, setSeason } from '../api.js';

// Series items carry `seasons` as a season COUNT (number); only episodes carry it as a tag-key list. Never assume an array.
const tagKeys = (it) => (Array.isArray(it.seasonTags) ? it.seasonTags : Array.isArray(it.seasons) ? it.seasons : []);

export function inSeason(it, season) {
  return !!(it && (tagKeys(it).includes(season.key) || (Array.isArray(it.genres) ? it.genres : []).includes(season.genre)));
}

// One "⋯" button (admins only) opening a text menu: "Add to Halloween" / "Remove from Christmas" ...
let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
}
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

async function toggle(item, season) {
  const next = !inSeason(item, season);
  try {
    await setSeason(item.id, season.key, next);
    const set = new Set(tagKeys(item));
    if (next) set.add(season.key); else set.delete(season.key);
    item.seasonTags = [...set];   // not item.seasons: on a series that is the season count
    if (item.genres) item.genres = item.genres.filter((g) => g !== season.genre).concat(next ? [season.genre] : []);
    toast((next ? 'Added to ' : 'Removed from ') + season.title);
  } catch { toast('Could not update ' + season.title); }
}

function openMenu(anchor, item) {
  closeMenu();
  menuEl = el('div', { class: 'cast-menu', role: 'menu' },
    el('div', { class: 'cast-menu-h' }, 'Seasonal rows'),
    ...SEASONS.map((s) => el('button', { class: 'cast-menu-i', type: 'button', role: 'menuitem',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); toggle(item, s); } },
    (inSeason(item, s) ? 'Remove from ' : 'Add to ') + s.title)));
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect(), w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  menuEl.style.top = (r.bottom + 6 + h < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    menuEl && menuEl.querySelector('button')?.focus();
  }, 0);
}

// Returns an array (empty or one button); spread it into the parent's children. cls matches the neighbours.
export function seasonButtons(item, cls = 'btn-circle dm-btn') {
  if (isTV()) return [];   // admin tagging is a phone/desktop job; on a D-pad these steal focus from Play and the episode rows
  const b = el('button', { class: cls + ' hw-btn', type: 'button', hidden: true, title: 'More', 'aria-label': 'More options',
    'aria-haspopup': 'menu', 'data-k': 'season-menu' }, '\u22ef');
  isAdmin().then((ok) => { if (ok) b.hidden = false; });
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (menuEl) closeMenu(); else openMenu(b, item); });
  return [b];
}
