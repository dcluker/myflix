// "Take it with me": a bar that appears on phones and tablets while one of your TVs is playing something.
// One tap stops the TV and opens the same title here (the native player resumes at the same second).
import * as store from '../store.js';
import { el, toast, parseHash } from '../util.js';
import { getHandoff, takeHandoff, playUrl } from '../api.js';
import { loadTargets, isCastable, remote, castIcon } from './cast.js';

const POLL_MS = 8000;

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
}

function label(p) {
  if (p.seriesName) return p.seriesName + (p.season != null && p.episode != null ? ' · S' + p.season + ' E' + p.episode : '');
  return p.name || 'Playing';
}

function dismissedKey(p) { return 'myflix.handoff.' + p.itemId; }
function dismissed(p) { try { return sessionStorage.getItem(dismissedKey(p)) === '1'; } catch { return false; } }

export function initHandoff() {
  let bar = null, current = null, busy = false, timer = null;

  const hide = () => { if (bar) { bar.remove(); bar = null; } current = null; };

  const take = async (p, btn) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Moving…';
    try {
      const r = await takeHandoff(p.device);
      if (!r.tvStopped && p.canStop) toast('Could not stop the ' + p.tv + ' TV. Pause it there.');
      location.href = playUrl(r.itemId);
      // The native player opens over this page (no reload), so the button would stay on "Moving…" when you come back.
      setTimeout(() => { busy = false; hide(); tick(); }, 1500);
    } catch (e) {
      busy = false;
      btn.disabled = false;
      btn.replaceChildren(el('span', { class: 'long' }, 'Take it with me'), el('span', { class: 'short' }, 'Take it'));
      if (e && e.status === 404) { toast('Nothing is playing on the TV any more.'); hide(); } else toast('Could not move it. Try again.');
    }
  };

  const paint = (p) => {
    if (!bar) {
      bar = el('div', { class: 'handoff', role: 'region', 'aria-label': 'Playing on a TV' });
      document.body.appendChild(bar);
    }
    current = p;
    const btn = el('button', { class: 'handoff-go', type: 'button' }, el('span', { class: 'long' }, 'Take it with me'), el('span', { class: 'short' }, 'Take it'));
    btn.addEventListener('click', () => take(p, btn));
    const x = el('button', { class: 'handoff-x', type: 'button', 'aria-label': 'Hide' }, '×');
    x.addEventListener('click', () => { try { sessionStorage.setItem(dismissedKey(p), '1'); } catch {} hide(); });
    // Remote (TVs the server can drive): back 10, play/pause, forward 10, stop. Own row under the title.
    const rcb = (icon, label, size, fn, cls) => el('button', { class: 'handoff-rcb' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label, title: label, html: castIcon(icon, size),
      onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } finally { setTimeout(() => { b.disabled = false; }, 900); } } });
    const poke = () => { setTimeout(tick, 1200); };
    const rc = isCastable(p.device) ? el('div', { class: 'handoff-rc' },
      rcb('back10', 'Back 10 seconds', 26, async () => { await remote(p.device, 'rewind'); poke(); }),
      rcb(p.paused ? 'play' : 'pause', p.paused ? 'Play' : 'Pause', 26, async () => { await remote(p.device, p.paused ? 'play' : 'pause'); poke(); }, 'handoff-pp'),
      rcb('fwd10', 'Forward 10 seconds', 26, async () => { await remote(p.device, 'forward'); poke(); }),
      rcb('stop', 'Stop', 20, async () => { if (await remote(p.device, 'stop')) { hide(); setTimeout(tick, 1500); } }, 'handoff-stop')) : null;
    const kids = [
      el('div', { class: 'handoff-txt' },
        el('div', { class: 'handoff-top' }, p.tv + ' \u00b7 ' + (p.paused ? 'Paused' : 'Playing')),
        el('div', { class: 'handoff-title' }, label(p)),
        el('div', { class: 'handoff-sub' }, p.runtimeMs ? clock(p.positionMs) + ' of ' + clock(p.runtimeMs) : clock(p.positionMs))),
      btn, x];
    if (rc) kids.push(rc);   // replaceChildren() would print a null child as the text "null"
    bar.replaceChildren(...kids);
  };

  const tick = async () => {
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS);
    if (busy || document.visibilityState !== 'visible' || !store.get('profile') || parseHash().name === 'profiles') return;
    let p = null;
    try { p = await getHandoff(); } catch { return; }       // a blip keeps whatever is showing
    if (busy) return;
    if (!p || dismissed(p)) return hide();
    if (current && current.itemId === p.itemId && current.paused === p.paused && bar) {    // same title and state: just move the clock, keep the buttons
      current = p;
      const sub = bar.querySelector('.handoff-sub'), top = bar.querySelector('.handoff-top');
      if (sub) sub.textContent = p.runtimeMs ? clock(p.positionMs) + ' of ' + clock(p.runtimeMs) : clock(p.positionMs);
      if (top) top.textContent = p.tv + ' · ' + (p.paused ? 'Paused' : 'Playing');
      return;
    }
    paint(p);
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('pageshow', tick);
  loadTargets().then(tick);
}
