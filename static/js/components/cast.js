// Cast to TV for phones, tablets and desktops: which TVs are castable, the cast-to menu, and the play/pause/stop remote.
// The TV UI never uses this (the TV plays natively). Everything goes through the same server endpoints as the Echo Hub.
import { el, toast, isTV } from '../util.js';
import { getCastTargets, castPlay, castControl } from '../api.js';

const KEY = 'myflix.cast.target';
let targets = null;      // [{device, name, enabled}]
let loading = null;

export function loadTargets() {
  if (isTV()) return Promise.resolve([]);
  if (targets) return Promise.resolve(targets);
  if (!loading) {
    loading = getCastTargets()
      .then((t) => { targets = (Array.isArray(t) ? t : []).filter((x) => x && x.enabled); return targets; })
      .catch(() => { loading = null; return []; });   // a blip: try again next time
  }
  return loading;
}

export function targetName(device) {
  const t = (targets || []).find((x) => x.device === device);
  return t ? t.name : 'TV';
}
export function isCastable(device) { return (targets || []).some((x) => x.device === device); }

function lastTarget() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function rememberTarget(d) { try { localStorage.setItem(KEY, d); } catch {} }

// Flat icons, same look as the rest (currentColor, 24 box).
const P = {
  cast: '<path d="M3 5.5h18a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1h-6.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M2.5 11.2a7.3 7.3 0 0 1 7.3 7.3M2.5 15a3.5 3.5 0 0 1 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="3.2" cy="18.4" r="1.4" fill="currentColor"/>',
  play: '<path d="M8 5.2v13.6c0 .6.7 1 1.2.6l10.2-6.8c.5-.3.5-1 0-1.3L9.2 4.6C8.7 4.2 8 4.6 8 5.2z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>',
  back10: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5.2A8 8 0 1 1 4.1 13.4"/></g><path d="M12.6 1.6v7.2L7.4 5.2z" fill="currentColor"/><text x="12" y="16" text-anchor="middle" font-size="7.6" font-weight="700" fill="currentColor" font-family="Helvetica Neue,Helvetica,Arial,sans-serif">10</text>',
  fwd10: '<g transform="translate(24 0) scale(-1 1)"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5.2A8 8 0 1 1 4.1 13.4"/></g><path d="M12.6 1.6v7.2L7.4 5.2z" fill="currentColor"/></g><text x="12" y="16" text-anchor="middle" font-size="7.6" font-weight="700" fill="currentColor" font-family="Helvetica Neue,Helvetica,Arial,sans-serif">10</text>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
};
export function castIcon(name, size = 22) {
  return `<svg class="icon icon-cast-${name}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${P[name]}</svg>`;
}

function errText(e, name) {
  const c = e && e.code;
  if (c === 'tv_unreachable') return `Can\u2019t reach ${name}. Is it on?`;
  if (c === 'rate_limited') return 'Slow down a little.';
  if (c === 'cast_disabled' || c === 'cast_unavailable') return 'Casting isn\u2019t set up for that TV.';
  return 'Couldn\u2019t cast' + (c ? ': ' + c : '.');
}

function askReplace(text) {
  return new Promise((resolve) => {
    const done = (v) => { box.remove(); resolve(v); };
    const box = el('div', { class: 'cast-ask', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'cast-ask-card' },
        el('p', {}, text),
        el('div', { class: 'cast-ask-row' },
          el('button', { class: 'cast-ask-no', type: 'button', onclick: () => done(false) }, 'Cancel'),
          el('button', { class: 'cast-ask-yes', type: 'button', onclick: () => done(true) }, 'Cast instead'))));
    document.body.appendChild(box);
  });
}

// Send one title to one TV. If the TV is already playing something, ask before replacing it.
export async function castTo(device, itemId) {
  const name = targetName(device);
  rememberTarget(device);
  try {
    await castPlay(device, itemId, false);
  } catch (e) {
    if (e && e.code === 'tv_busy') {
      const what = e.data && e.data.playing ? ` \u201c${e.data.playing}\u201d` : ' something';
      // window.confirm() is a silent "no" inside the iOS app's WKWebView, so ask with an in-page dialog
      if (!(await askReplace(`${name} is playing${what}. Cast this instead?`))) return false;
      try { await castPlay(device, itemId, true); } catch (e2) { toast(errText(e2, name)); return false; }
    } else { toast(errText(e, name)); return false; }
  }
  toast('Sent to ' + name);
  return true;
}

// Pick a TV (menu next to the button) and cast. One castable TV: cast straight away.
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('pointerdown', outside, true); } }
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

export async function castMenu(anchor, itemId) {
  const ts = await loadTargets();
  if (!ts.length) { toast('No TVs set up to cast to.'); return; }
  if (ts.length === 1) { castTo(ts[0].device, itemId); return; }
  closeMenu();
  const last = lastTarget();
  menuEl = el('div', { class: 'cast-menu', role: 'menu' },
    el('div', { class: 'cast-menu-h' }, 'Cast to'),
    ...ts.map((t) => el('button', { class: 'cast-menu-i' + (t.device === last ? ' is-last' : ''), type: 'button', role: 'menuitem',
      onclick: () => { closeMenu(); castTo(t.device, itemId); } }, t.name)));
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect(), w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 6 + h < window.innerHeight;
  menuEl.style.left = left + 'px';
  menuEl.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}

// Remote controls for a TV that is playing (used by the "playing on a TV" bar).
export async function remote(device, action) {
  try { await castControl(device, action); return true; }
  catch (e) { toast(errText(e, targetName(device))); return false; }
}
