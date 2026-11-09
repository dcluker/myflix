// Voice search: tap the mic, speak a title, a local whisper service turns it into text (POST /api/echo/stt).
// Not offered on the Fire TV (its remote mic is not reachable from a web view). Shared by every browser client.
import * as store from './store.js';
import { el, icon } from './util.js';

export function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder) && !document.documentElement.classList.contains('tv');
}

const FILLER = /^(?:(?:please|hey|ok|okay)\s+)*(?:(?:can you|could you)\s+)?(?:(?:play|watch|put on|show me|show|find|search for|search|look up|look for|i want to watch|i wanna watch|let'?s watch)\s+)+(?:(?:me|the movie|the show|the series|a movie|a show|movie|show|some)\s+)*/;
export function cleanQuery(t) {
  const n = String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  return n.replace(FILLER, '').trim();
}

let cur = null;
function close() {
  const v = cur; cur = null;
  if (!v) return;
  v.dead = true;
  try { if (v.rec && v.rec.state !== 'inactive') v.rec.stop(); } catch {}
  if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
  try { if (v.ac) v.ac.close(); } catch {}
  clearTimeout(v.cap); clearInterval(v.vad);
  v.box.remove();
}

function show(v, msg, sub, btn) {
  v.box.textContent = '';
  v.box.append(el('div', { class: 'voice-card' },
    el('div', { class: 'voice-mic' + (msg === 'Listening…' ? ' live' : ''), html: icon('mic', 48) }),
    el('div', { class: 'voice-msg' }, msg),
    sub ? el('div', { class: 'voice-sub' }, sub) : null,
    el('button', { type: 'button', class: 'voice-btn', onclick: btn ? btn[1] : close }, btn ? btn[0] : 'Cancel')));
}

/** Opens the listening card; calls onText(cleanedQuery) when a title was heard. */
export async function listen(onText) {
  if (cur) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('Microphone is blocked. Allow it for this site to use voice search.'); return; }
  const box = el('div', { class: 'voice-dim', role: 'dialog', 'aria-label': 'Voice search', onclick: (e) => { if (e.target === box) close(); } });
  document.body.appendChild(box);
  const v = cur = { box, stream, chunks: [], t0: Date.now(), heard: false };
  const retry = ['Try again', () => { close(); listen(onText); }];
  const rec = v.rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) v.chunks.push(e.data); };
  rec.onstop = async () => {
    if (v.dead) return;
    const blob = new Blob(v.chunks, { type: rec.mimeType || 'audio/webm' });
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(v.vad); clearTimeout(v.cap);
    if (!v.heard || blob.size < 1500) { show(v, 'Didn’t catch that', 'Tap the mic and try again', retry); return; }
    show(v, 'Searching…', '');
    let text = '';
    try {
      const r = await fetch('/api/echo/stt', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm', 'X-MyFlix-Profile': (store.get('profile') || {}).userId || '' }, body: blob });
      if (!r.ok) throw new Error('http ' + r.status);
      text = ((await r.json()).text || '').trim();
    } catch { if (!v.dead) show(v, 'Voice search is unavailable', 'Try again in a moment', ['Close', close]); return; }
    if (v.dead) return;
    const q = cleanQuery(text);
    if (!q) { show(v, 'Didn’t catch that', text ? '“' + text + '”' : '', retry); return; }
    close();
    onText(q);
  };
  try {   // stop ~1.2 s after speech ends
    const ac = v.ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize); let quiet = 0;
    v.vad = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      if (peak > 8) { v.heard = true; quiet = 0; } else quiet += 100;
      if ((v.heard && quiet >= 1200) || (!v.heard && Date.now() - v.t0 > 4500)) { try { rec.stop(); } catch {} clearInterval(v.vad); }
    }, 100);
  } catch { v.heard = true; }
  rec.start();
  v.cap = setTimeout(() => { try { rec.stop(); } catch {} }, 7000);
  show(v, 'Listening…', 'Say a title, e.g. “Lion King”', ['Done', () => { try { rec.stop(); } catch {} }]);
}
