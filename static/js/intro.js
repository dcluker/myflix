// Launch intro: the MYFLIX wordmark rises out of the dark with a two-hit "boom" and a light sweep, then
// breaks apart into ~60 thin, multi-coloured vertical light bars that fan out across the screen, drift and fade
// into the app (the bars are plain divs animated with transform + opacity only, so the TV stays smooth). Plays once per session (once per app launch on the TV), any
// key / tap / click skips it, reduced-motion users get a short fade, and ?nointro turns it off.
// The sound is synthesized here with WebAudio (nothing to download); the TV WebView allows it
// without a tap (mediaPlaybackRequiresUserGesture = false in the Android shell).

const SEEN_KEY = 'mf_intro_seen';
const SOUND_KEY = 'mf_intro_sound';   // '0' = silent; anything else (or unset) = sound on

export function introSoundOn() {
  try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; }
}
export function setIntroSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch {}
}
const TOTAL_MS = 4300;
const BARS = 72;

const CSS = `
#mf-intro{position:fixed;inset:0;z-index:99999;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;
  opacity:1;transition:opacity .5s ease;cursor:none;contain:layout paint;will-change:opacity}
#mf-intro.out{opacity:0;pointer-events:none}
/* Only transform and opacity are animated below: those run on the GPU compositor, so the TV's weak CPU
   can't drop frames. (No blur filters, letter-spacing, width or blend modes.) */
#mf-intro .mfi-glow{position:absolute;left:50%;top:50%;width:56vw;height:24vw;margin:-12vw 0 0 -28vw;opacity:0;will-change:transform,opacity;
  background:radial-gradient(ellipse at center,rgba(229,9,20,.5) 0%,rgba(229,9,20,.16) 42%,rgba(229,9,20,0) 70%);
  transform:scale(.3);animation:mfiGlow 2.6s cubic-bezier(.2,.7,.2,1) .4s forwards}
#mf-intro .mfi-streak{position:absolute;left:5vw;top:50%;width:90vw;height:2px;margin-top:-1px;opacity:0;will-change:transform,opacity;
  background:linear-gradient(90deg,rgba(255,255,255,0),#fff 50%,rgba(255,255,255,0));box-shadow:0 0 14px 3px rgba(229,9,20,.7);
  transform:scaleX(0);animation:mfiStreak .8s cubic-bezier(.3,.8,.2,1) .1s forwards}
#mf-intro .mfi-wrap{position:relative;overflow:hidden;padding:.05em .25em;opacity:0;will-change:transform,opacity;
  transform:scale(1.18);animation:mfiWord 1.75s cubic-bezier(.25,.6,.2,1) .55s forwards}
#mf-intro .mfi-word{font-family:var(--font-logo,'Bebas Neue',Impact,sans-serif);color:var(--red,#e50914);font-size:min(22vw,24vh);line-height:1;
  letter-spacing:.18em;margin-right:-.18em;white-space:nowrap;text-shadow:0 0 24px rgba(229,9,20,.5)}
#mf-intro .mfi-sweep{position:absolute;top:0;bottom:0;left:0;width:35%;pointer-events:none;opacity:.9;will-change:transform;
  background:linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.35) 50%,rgba(255,255,255,0) 100%);
  transform:translateX(-120%);animation:mfiSweep .95s ease-in-out 1.5s forwards}
@keyframes mfiStreak{0%{opacity:1;transform:scaleX(0)}70%{opacity:1;transform:scaleX(1)}100%{opacity:0;transform:scaleX(1.04)}}
@keyframes mfiGlow{0%{opacity:0;transform:scale(.3)}30%{opacity:1}100%{opacity:0;transform:scale(1.5)}}
@keyframes mfiWord{
  0%{opacity:0;transform:scale(1.18)}
  28%{opacity:1;transform:scale(1)}
  84%{opacity:1;transform:scale(1.025)}
  100%{opacity:0;transform:scale(1.07)}}
/* The break: bars start bunched in the wordmark's footprint, spread to their places across the screen while they grow tall
   and drift, then lift away and thin out. Per-bar numbers (--x --w --sx --h --dy --d, colours) are set in JS. */
#mf-intro .mfi-bars{position:absolute;inset:0;pointer-events:none}
#mf-intro .mfi-bar{position:absolute;top:50%;left:var(--x);width:var(--w);height:100vh;margin-top:-50vh;opacity:0;will-change:transform,opacity;
  background:linear-gradient(to bottom,var(--c0) 0%,var(--c1) 18%,var(--c2) 50%,var(--c1) 82%,var(--c0) 100%);border-radius:999px;
  transform:translate(var(--sx),0) scaleY(.2);animation:mfiBar 2.35s cubic-bezier(.22,.7,.18,1) calc(1.78s + var(--d)) forwards}
@keyframes mfiBar{
  0%{opacity:0;transform:translate(var(--sx),0) scaleY(.2)}
  7%{opacity:1}
  42%{opacity:1;transform:translate(0,var(--dy)) scaleY(var(--h))}
  76%{opacity:.95;transform:translate(0,calc(var(--dy)*-.55)) scaleY(calc(var(--h)*1.06))}
  100%{opacity:0;transform:translate(0,calc(var(--dy)*-1.5)) scaleY(.04)}}
@keyframes mfiSweep{to{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){
  #mf-intro .mfi-glow,#mf-intro .mfi-streak,#mf-intro .mfi-sweep,#mf-intro .mfi-bars{display:none}
  #mf-intro .mfi-wrap{animation:mfiSimple 1.2s ease .1s forwards;transform:none}
  @keyframes mfiSimple{0%{opacity:0}35%,70%{opacity:1}100%{opacity:0}}}
`;

// The accent as a hue (0-360), so the bars start from the theme colour and sweep through the spectrum.
function accentHue() {
  try {
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 355;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 355;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  } catch { return 355; }
}

function barsHTML() {
  const base = accentHue();
  let out = '';
  for (let i = 0; i < BARS; i++) {
    const k = i / (BARS - 1);                       // 0..1 across the screen
    const hue = (base + 24 - k * 150 + (Math.random() * 16 - 8) + 720) % 360;   // orange-red -> accent -> magenta -> violet -> blue
    const hue2 = (hue + 330) % 360;                 // a touch toward magenta in the core
    const w = 0.32 + Math.random() * 0.78;          // vw: thin streaks with black between them
    const x = k * 99 + (Math.random() * 0.5 - 0.25);
    const startX = 14 + k * 72;                     // bunched where the wordmark was
    const h = 0.34 + Math.random() * 0.66;
    const dy = (Math.random() * 14 - 7) * (i % 2 ? 1 : -1);
    const d = Math.abs(i - BARS / 2) * 13 + Math.random() * 150;   // from the centre outwards
    out += '<i class="mfi-bar" style="--x:' + x.toFixed(2) + 'vw;--w:' + w.toFixed(2) + 'vw;--sx:' + (startX - x).toFixed(2) + 'vw;--h:' + h.toFixed(2)
      + ';--dy:' + dy.toFixed(1) + 'vh;--d:' + d.toFixed(0) + 'ms;--c0:hsla(' + hue.toFixed(0) + ',100%,55%,0);--c1:hsl(' + hue.toFixed(0)
      + ',100%,56%);--c2:hsl(' + hue2.toFixed(0) + ',100%,64%)"></i>';
  }
  return '<div class="mfi-bars">' + out + '</div>';
}

function boom(ctx, out, t, f0, f1, len, gain) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + len);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + len + 0.05);
}

function chord(ctx, out, t, freqs, len, gain) {
  for (const f of freqs) {
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2400, t);
      lp.frequency.exponentialRampToValueAtTime(260, t + len);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(lp).connect(g).connect(out);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }
}

function playSound() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  if (ctx.state === 'suspended') { try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch {} }
  const master = ctx.createGain();
  master.gain.value = 0.55;
  // A short feedback delay gives the hits a little room.
  const delay = ctx.createDelay(0.5);
  const fb = ctx.createGain();
  delay.delayTime.value = 0.17;
  fb.gain.value = 0.28;
  delay.connect(fb).connect(delay);
  master.connect(ctx.destination);
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  wet.connect(delay);
  delay.connect(master);
  const bus = ctx.createGain();
  bus.connect(master);
  bus.connect(wet);

  const t0 = ctx.currentTime + 0.05;
  // Rising swell (filtered noise) under the first hit.
  const len = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(180, t0);
  bp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.9);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t0);
  ng.gain.exponentialRampToValueAtTime(0.5, t0 + 0.85);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.15);
  n.connect(bp).connect(ng).connect(bus);
  n.start(t0);
  // Hit one (the reveal) and a deeper hit two.
  boom(ctx, bus, t0 + 0.8, 120, 42, 1.5, 0.95);
  chord(ctx, bus, t0 + 0.8, [110, 164.8, 220], 1.1, 0.05);
  boom(ctx, bus, t0 + 1.35, 90, 32, 1.7, 1.0);
  chord(ctx, bus, t0 + 1.35, [82.4, 123.5, 164.8], 1.5, 0.06);
  return ctx;
}

/**
 * Mounts the black overlay straight away (so the page never flashes) but holds the animation until
 * start() is called, which the app does once its first screen is drawn: nothing else is working while
 * it plays, so it stays smooth. Returns { start, cancel }. Safe to call when the intro is not wanted.
 */
export function prepareIntro() {
  const noop = { start() {}, cancel() {} };
  try {
    if (/[?&]nointro\b/.test(location.search + location.hash)) return noop;
    if (sessionStorage.getItem(SEEN_KEY)) return noop;
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch { /* private mode: just play it */ }

  const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const style = document.createElement('style');
  style.textContent = CSS + '#mf-intro:not(.go) *{animation-play-state:paused!important}';
  const box = document.createElement('div');
  box.id = 'mf-intro';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = '<div class="mfi-glow"></div><div class="mfi-streak"></div>' + (reduced ? '' : barsHTML())
    + '<div class="mfi-wrap"><div class="mfi-word">MYFLIX</div><div class="mfi-sweep"></div></div>';
  document.head.appendChild(style);
  document.body.appendChild(box);

  let ctx = null;
  let done = false;
  let started = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', skip, true);
    window.removeEventListener('pointerdown', skip, true);
    box.classList.add('out');
    if (ctx) { const c = ctx; setTimeout(() => { try { const r = c.close(); if (r && r.catch) r.catch(() => {}); } catch {} }, 700); }
    setTimeout(() => { box.remove(); style.remove(); }, 550);
  };
  function skip(e) { if (e) { e.stopPropagation(); e.preventDefault(); } finish(); }
  window.addEventListener('keydown', skip, true);
  window.addEventListener('pointerdown', skip, true);
  setTimeout(() => { if (!started) finish(); }, 15000);   // the app never got going: do not hold the screen black

  const start = () => {
    if (done || started) return;
    started = true;
    const go = () => {
      if (done) return;
      box.classList.add('go');
      if (!reduced && introSoundOn()) { try { ctx = playSound(); } catch { ctx = null; } }
      setTimeout(finish, reduced ? 1400 : TOTAL_MS);
    };
    // Wait briefly for the logo font so the wordmark doesn't pop in a fallback face.
    let fired = false;
    const once = () => { if (!fired) { fired = true; go(); } };
    try { document.fonts.ready.then(once); } catch { once(); }
    setTimeout(once, 700);
  };
  return { start, cancel: finish };
}
