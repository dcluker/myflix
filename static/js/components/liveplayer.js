// Built-in live player for browsers (desktop, phone, tablet). The native apps keep their own players.
// Order of attempts: the channel's own HLS stream (Safari and recent Chrome play it natively, others via hls.js); if the host
// does not allow browser playback (no CORS) retry through MyFlix's relay; then through Jellyfin's transcode; if all fail,
// offer Jellyfin's player. The tier that worked is remembered per channel for the session.
import { el } from '../util.js';
import { getLivePlay, stopLive, playUrl } from '../api.js';

const HLS_SRC = new URL('../vendor/hls.light.min.js', import.meta.url).href;
let hlsLoad = null;
let open = null;   // the one open player, if any
const TIERS = ['direct', 'relay', 'transcode'];
const memo = () => { try { return JSON.parse(sessionStorage.getItem('myflix.live.tier') || '{}'); } catch { return {}; } };
const remember = (id, tier) => { try { const m = memo(); m[id] = tier; sessionStorage.setItem('myflix.live.tier', JSON.stringify(m)); } catch {} };

const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios).)*safari/i.test(navigator.userAgent || '');
export const isNativeApp = () => /MyFlixApp|MyFlixTV/.test(navigator.userAgent || '');

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoad) {
    hlsLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_SRC;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js missing')));
      s.onerror = () => { hlsLoad = null; reject(new Error('hls.js failed to load')); };
      document.head.append(s);
    });
  }
  return hlsLoad;
}

// channels: [{id, name, now?}] in the order prev / next should walk. start: index into it.
export function openLivePlayer(channels, start, opener) {
  if (open || !channels.length) return;
  let idx = Math.max(0, Math.min(start, channels.length - 1));
  let hls = null;
  let liveStreamId = '';
  let gen = 0;          // bumps on every channel change so a slow load cannot overwrite a newer one
  let idleTimer = 0;

  const video = el('video', { class: 'lp-video', playsinline: '', controls: '', autoplay: '' });
  const title = el('div', { class: 'lp-title' });
  const sub = el('div', { class: 'lp-sub' });
  const msg = el('div', { class: 'lp-msg', role: 'status', 'aria-live': 'polite' });
  const btn = (label, text, fn, cls = '') => el('button', { class: 'lp-btn ' + cls, type: 'button', 'aria-label': label, title: label, onclick: fn }, text);
  const bar = el('div', { class: 'lp-bar' },
    btn('Close (Esc)', '✕', () => close(), 'lp-close'),
    el('div', { class: 'lp-who' }, title, sub),
    btn('Previous channel', '▲', () => step(-1)),
    btn('Next channel', '▼', () => step(1)));
  const root = el('div', { class: 'lp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Live channel' }, video, bar, msg);
  document.body.append(root);
  document.body.classList.add('lp-open');

  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!msg.textContent) root.classList.add('idle'); }, 3500);
  }
  ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => root.addEventListener(ev, wake, { passive: true }));

  function release() {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    if (liveStreamId) { stopLive(liveStreamId).catch(() => {}); liveStreamId = ''; }
  }

  function fail(why, id) {
    msg.replaceChildren(el('div', null, why),
      el('div', { class: 'lp-actions' },
        btn('Try again', 'Try again', () => play(), 'lp-wide'),
        el('a', { class: 'lp-btn lp-wide', href: playUrl(id), target: '_blank', rel: 'noopener' }, 'Open in Jellyfin')));
    root.classList.remove('idle');
  }

  function attach(url, ch, g, direct) {
    return new Promise((resolve, reject) => {
      const stale = () => g !== gen;
      const onFatal = (e) => { if (!stale()) reject(e instanceof Error ? e : new Error('stream error')); };
      const native = () => {
        video.src = url;
        video.addEventListener('error', () => onFatal(new Error('native playback error')), { once: true });
        video.addEventListener('playing', () => resolve(), { once: true });
        video.play().catch(() => {});
      };
      // Safari plays HLS best natively (and needs no CORS for a media element). Elsewhere hls.js is more tolerant than
      // the browser's own HLS support (recent Chrome has one), which stumbles on stitched ad streams.
      if (IS_SAFARI && video.canPlayType('application/vnd.apple.mpegurl')) { native(); }
      else {
        loadHls().then((Hls) => {
          if (stale()) return;
          if (!Hls.isSupported()) {
            if (video.canPlayType('application/vnd.apple.mpegurl')) native();
            else onFatal(new Error('This browser cannot play live streams.'));
            return;
          }
          hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1 });
          hls.on(Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) onFatal(new Error(d.details || 'stream error')); });
          hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
          video.addEventListener('playing', () => resolve(), { once: true });
          hls.loadSource(url);
          hls.attachMedia(video);
        }).catch(onFatal);
      }
      // A stream that never starts: give up so the next fallback (or the error) shows.
      setTimeout(() => { if (!stale() && video.readyState < 2) onFatal(new Error('timeout')); }, direct ? 12000 : 25000);
    });
  }

  async function play() {
    const g = ++gen;
    const ch = channels[idx];
    release();
    title.textContent = ch.name;
    sub.textContent = ch.now || '';
    msg.replaceChildren(el('div', { class: 'lp-spin' }), el('div', null, 'Loading…'));
    root.classList.remove('idle');
    const first = Math.max(0, TIERS.indexOf(memo()[ch.id]));
    for (const mode of TIERS.slice(first)) {
      let info;
      try { info = await getLivePlay(ch.id, mode); } catch { continue; }
      if (g !== gen) {   // channel changed while this was opening: the server already holds the stream, close it
        if (info && info.liveStreamId) stopLive(info.liveStreamId).catch(() => {});
        return;
      }
      if (mode === 'transcode' && info.direct) continue;
      liveStreamId = info.liveStreamId || '';
      if (info.name) title.textContent = info.name;
      try {
        await attach(info.streamUrl, ch, g, !!info.direct);
        if (g !== gen) return;
        remember(ch.id, mode);
        msg.replaceChildren();
        wake();
        return;
      } catch (err) {
        if (g !== gen) return;
        (window.__lpLog = window.__lpLog || []).push(mode + ': ' + ((err && err.message) || err));   // for diagnosing a channel
        release();
      }
    }
    if (g === gen) fail("This channel isn't streaming right now.", ch.id);
  }

  function step(d) {
    idx = (idx + d + channels.length) % channels.length;
    play();
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); close(); }
    else if (e.key === 'ChannelUp' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'ChannelDown' || e.key === 'PageDown') { e.preventDefault(); step(1); }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pagehide', release);
    clearTimeout(idleTimer);
    gen++;
    release();
    root.remove();
    document.body.classList.remove('lp-open');
    open = null;
    try { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); } catch {}
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('pagehide', release, { once: true });   // app closed mid-stream: free the T14 transcode
  open = { close };
  wake();
  play();
  try { bar.querySelector('.lp-close').focus({ preventScroll: true }); } catch {}
}
