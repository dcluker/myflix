// Echo Hub wake word: the page keeps the mic open, cuts the audio into short utterances (voice-activity detection),
// and sends each one to /api/echo/wake. The server transcribes it with local whisper, checks the editable wake-word list,
// throws the audio away and answers {wake, command}. Nothing leaves the LAN. A soft chime acknowledges a hit.

let cfg = { words: [], enabled: false, chime: true };
let ctx = null, stream = null, proc = null, running = false, paused = 0, onHit = null, headers = () => ({});
let noise = 2;   // adaptive background level (0-128 scale)
let testCb = null;   // while set, results go here (the panel's test) instead of triggering anything

// Sensitivity 1 (picky) .. 5 (hears everything): [minimum level, multiple of the room noise]
const SENS = { 1: [6, 3.0], 2: [4, 2.5], 3: [3, 2.0], 4: [2.5, 1.8], 5: [1.5, 1.4] };
export const getSens = () => { try { const v = +localStorage.getItem('echo.wakeSens'); return SENS[v] ? v : 4; } catch { return 4; } };
export function setSens(v) { try { localStorage.setItem('echo.wakeSens', String(v)); } catch {} }
export function setTest(cb) { testCb = cb; }

export const wakeState = { get on() { return running; } };
export const wakeLevel = { peak: 0, noise: 0, thr: 0, segs: 0, sent: 0, heard: '' };   // shown live in the Wake words panel

export async function loadWake() {
  try {
    const r = await fetch('/api/echo/wakewords', { credentials: 'same-origin', cache: 'no-store', headers: headers() });
    if (r.ok) cfg = await r.json();
  } catch {}
  return cfg;
}
export async function saveWake(patch) {
  const r = await fetch('/api/echo/wakewords', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error('save failed');
  cfg = await r.json();
  if (cfg.enabled) start(); else stop();
  return cfg;
}
export const getWake = () => cfg;
export function pauseWake(on) { paused = Math.max(0, paused + (on ? 1 : -1)); }

// Soft two-note "ding" (rising fifth), quiet on purpose.
export function chime() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const t = c.currentTime;
    [[784, 0], [1175, 0.11]].forEach(([f, d]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.09, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.32);
      o.connect(g).connect(c.destination); o.start(t + d); o.stop(t + d + 0.35);
    });
    setTimeout(() => c.close(), 700);
  } catch {}
}

function wav16k(chunks, rate) {   // Float32 chunks at `rate` -> 16 kHz 16-bit mono WAV
  let n = 0; for (const c of chunks) n += c.length;
  const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  let mx = 0; for (let i = 0; i < n; i += 4) mx = Math.max(mx, Math.abs(all[i]));
  const gain = mx > 0.002 ? Math.min(40, 0.7 / mx) : 1;   // quiet mic: bring the clip up to a normal level for whisper
  const ratio = rate / 16000, m = Math.floor(n / ratio), pcm = new Int16Array(m);
  for (let i = 0; i < m; i++) { const a = (all[Math.floor(i * ratio)] || 0) * gain; pcm[i] = Math.max(-1, Math.min(1, a)) * 32767; }
  const buf = new ArrayBuffer(44 + m * 2), v = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + m * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, m * 2, true); new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

let sending = false;
async function submit(chunks, rate) {
  if (sending) return;
  sending = true;
  try {
    const r = await fetch('/api/echo/wake', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav', ...headers(), ...(testCb ? { 'X-Wake-Debug': '1' } : {}) }, body: wav16k(chunks, rate) });
    if (!r.ok) return;
    const d = await r.json();
    wakeLevel.sent++; wakeLevel.heard = d.wake ? 'wake word' : 'no wake word';
    if (testCb) { testCb(d); return; }
    if (d.off) { cfg.enabled = false; stop(); return; }
    if (d.wake && onHit) { if (cfg.chime) chime(); onHit(d.command || ''); }
  } catch {} finally { sending = false; }
}

export async function start() {
  if (running || !cfg.enabled || !cfg.words.length) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(2048, 1, 1);
  const rate = ctx.sampleRate, hop = 2048 / rate;
  let pre = [], seg = null, quietT = 0, segT = 0;
  proc.onaudioprocess = (e) => {
    const x = e.inputBuffer.getChannelData(0);
    if (paused || document.hidden || sending) { seg = null; pre = []; return; }
    let peak = 0; for (let i = 0; i < x.length; i += 2) peak = Math.max(peak, Math.abs(x[i]));
    peak *= 128;
    const [floor, mult] = SENS[getSens()];
    const thr = Math.max(floor, noise * mult);
    const loud = peak > thr;
    wakeLevel.peak = Math.max(peak, wakeLevel.peak * 0.9); wakeLevel.noise = noise; wakeLevel.thr = thr;
    if (!seg && !loud) noise = noise * 0.98 + Math.min(peak, 20) * 0.02;
    const copy = new Float32Array(x);
    if (!seg) {
      pre.push(copy); if (pre.length > 4) pre.shift();   // ~0.4 s of lead-in so the first syllable is kept
      if (loud) { seg = pre.slice(); quietT = 0; segT = 0; pre = []; }
      return;
    }
    seg.push(copy); segT += hop;
    quietT = loud ? 0 : quietT + hop;
    if (quietT >= 0.7 || segT >= 4) {
      const chunks = seg; seg = null;
      if (segT - quietT >= 0.25) { wakeLevel.segs++; submit(chunks, rate); }   // ignore clicks and bumps
    }
  };
  src.connect(proc); proc.connect(ctx.destination);   // destination keeps the node running; it outputs silence
  running = true;
}

export function stop() {
  running = false;
  try { proc && (proc.onaudioprocess = null, proc.disconnect()); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx && ctx.close(); } catch {}
  proc = ctx = stream = null;
}

export function initWake(hit, hdrFn) { onHit = hit; if (hdrFn) headers = hdrFn; return loadWake().then(() => start()); }
