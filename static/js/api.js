// Thin fetch wrapper over the MyFlix backend. Adds X-MyFlix-Profile from the store and routes
// to #/profiles when the server says the profile is gone or needs re-linking.
import * as store from './store.js';

const TIMEOUT_MS = 60000;

function fail(status, data, msg) {
  const e = new Error(msg || (data && data.error) || ('HTTP ' + status));
  e.status = status;
  e.data = data || null;
  e.code = (data && data.error) || null;
  return e;
}

function reloadOnceForAccess() {
  // Cloudflare Access session expired: a reload bounces through the SSO login.
  try {
    const last = Number(sessionStorage.getItem('myflix.reload') || 0);
    if (Date.now() - last < 15000) return;
    sessionStorage.setItem('myflix.reload', String(Date.now()));
  } catch {}
  location.reload();
}

async function request(path, { method = 'GET', body, profile = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (profile) {
    const p = store.get('profile');
    if (p && p.userId) headers['X-MyFlix-Profile'] = p.userId;
  }
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, signal: ctl.signal, credentials: 'same-origin' });
  } catch (e) {
    throw fail(0, null, e && e.name === 'AbortError' ? 'Request timed out' : 'Network error');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (res.ok) return data;

  const code = data && data.error;
  if (res.status === 401 && code === 'relink') {
    store.set('relink', (data && data.userId) || (store.get('profile') || {}).userId || true);
    if (location.hash !== '#/profiles') location.hash = '#/profiles';
  } else if (res.status === 403 && code === 'profile') {
    store.set('profile', null); // emits profile:changed -> app routes to #/profiles
    if (location.hash !== '#/profiles') location.hash = '#/profiles';
  } else if (res.status === 401 && code === 'unauthorized') {
    reloadOnceForAccess();
  }
  throw fail(res.status, data);
}

export async function getMe() {
  const me = await request('/api/me', { profile: false });
  store.set('me', me);
  return me;
}

async function refreshMe() {
  try { await getMe(); } catch {}
}

export async function linkProfile(username, password) {
  const p = await request('/api/profiles/link', { method: 'POST', body: { username, password }, profile: false });
  await refreshMe();
  return p;
}

export async function unlinkProfile(userId) {
  await request('/api/profiles/' + encodeURIComponent(userId), { method: 'DELETE', profile: false });
  const cur = store.get('profile');
  if (cur && cur.userId === userId) store.set('profile', null);
  await refreshMe();
}

export function getIndex({ refresh } = {}) {
  return request('/api/index' + (refresh ? '?refresh=1' : ''));
}

export function getLiveTv() { return request('/api/livetv'); }
export function getSettings() { return request('/api/settings'); }
export function saveTheme(theme) { return request('/api/settings/theme', { method: 'POST', body: theme }); }
export function changePassword(current, next) { return request('/api/settings/password', { method: 'POST', body: { current, new: next } }); }
export async function signOut() { try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }); } catch {} location.reload(); }
export function getLivePlay(id, mode = 'direct') { return request('/api/livetv/play/' + encodeURIComponent(id) + '?web=1' + (mode === 'direct' ? '' : '&mode=' + mode)); }
export function stopLive(liveStreamId) { return request('/api/livetv/stop', { method: 'POST', body: { liveStreamId } }); }
export function customizeProfile(body) { return request('/api/profiles/customize', { method: 'POST', body, profile: false }); }
export async function uploadProfilePhoto(userId, blob) {
  const res = await fetch('/api/profiles/photo?userId=' + encodeURIComponent(userId), {
    method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg', Accept: 'application/json' }, body: blob, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error((data && data.error) || 'HTTP ' + res.status); e.status = res.status; e.code = data && data.error; throw e; }
  return data;
}
export function getHome() { return request('/api/home'); }
export function getItem(id) { return request('/api/item/' + encodeURIComponent(id)); }
export function getSeason(seriesId, seasonId) {
  return request('/api/season/' + encodeURIComponent(seriesId) + '/' + encodeURIComponent(seasonId));
}

export function resetPosition(id) {
  return request('/api/item/' + encodeURIComponent(id) + '/restart', { method: 'POST', body: {} });
}

export async function setPlayed(id, played) {
  const r = await request('/api/item/' + encodeURIComponent(id) + '/played', { method: 'POST', body: { played: !!played } });
  const v = r && 'played' in r ? !!r.played : !!played;
  store.emit('item:changed', { id, played: v });
  return { played: v };
}

export async function setFavorite(id, favorite) {
  const r = await request('/api/item/' + encodeURIComponent(id) + '/favorite', { method: 'POST', body: { favorite: !!favorite } });
  const v = r && 'favorite' in r ? !!r.favorite : !!favorite;
  store.emit('item:changed', { id, favorite: v });
  return { favorite: v };
}

// Seasonal collections: a Jellyfin Genre per season. Keep in step with SEASONS in server.py.
export const SEASONS = [
  { key: 'halloween', genre: 'Halloween', emoji: '\u{1F383}', title: 'Halloween' },
  { key: 'christmas', genre: 'Christmas', emoji: '\u{1F384}', title: 'Christmas' },
];
// Add/remove a season tag on any movie, series or episode id (admin only; the server enforces it).
export async function setSeason(id, season, on) {
  const r = await request('/api/item/' + encodeURIComponent(id) + '/season', { method: 'POST', body: { season, on: !!on } });
  const v = r && 'on' in r ? !!r.on : !!on;
  store.emit('item:changed', { id, season, on: v });
  return { season, on: v };
}
let adminP = null;
export function isAdmin() {
  if (!adminP) adminP = getSettings().then((s) => !!(s && s.canSetGlobalTheme)).catch(() => { adminP = null; return false; });
  return adminP;
}

// ---- requests (Jellyseerr) ----
export function discoverSearch(q) { return request('/api/discover/search?q=' + encodeURIComponent(q)); }
export function discoverTv(tmdbId) { return request('/api/discover/tv/' + encodeURIComponent(tmdbId)); }
// seasons (tv only): 'all' or [n, ...]
export function requestTitle({ mediaType, tmdbId, seasons }) {
  const body = { mediaType, tmdbId };
  if (mediaType === 'tv') body.seasons = seasons == null ? 'all' : seasons;
  return request('/api/request', { method: 'POST', body });
}

// ---- sign in from a phone (TV shows a QR code; the phone types the password) ----
export function createLinkSession() { return request('/api/link-session', { method: 'POST', body: {}, profile: false }); }
export function pollLinkSession(code) { return request('/api/link-session/' + encodeURIComponent(code), { profile: false }); }

// ---- suggestions (one profile recommends a title to another) ----
export async function loadSuggestions() {
  const me = (store.get('profile') || {}).userId || '';
  if (store.get('suggestionsFor') !== me) { store.set('suggestions', []); store.set('suggestionsFor', me); }
  try {
    const list = await request('/api/suggestions');
    store.set('suggestions', Array.isArray(list) ? list : []);
  } catch { store.set('suggestions', store.get('suggestions') || []); }
  store.emit('suggestions:changed');
  return store.get('suggestions');
}
export function getSuggestTargets() { return request('/api/suggest/targets'); }
export function sendSuggestion(itemId, to, note) { return request('/api/suggest', { method: 'POST', body: { itemId, to, note } }); }
export async function dismissSuggestions(ids) {
  for (const id of ids) { try { await request('/api/suggestion/' + encodeURIComponent(id), { method: 'DELETE' }); } catch {} }
  const gone = new Set(ids);
  store.set('suggestions', (store.get('suggestions') || []).filter((s) => !gone.has(s.id)));
  store.emit('suggestions:changed');
}

// Cast to a TV (phones and browsers): the server wakes the TV and tells its MyFlix app to play the title.
export function getCastTargets() { return request('/api/cast/targets'); }
export function castPlay(device, itemId, force) { return request('/api/cast', { method: 'POST', body: { device, itemId, force: !!force } }); }
export function castControl(device, action) { return request('/api/cast/control', { method: 'POST', body: { device, action } }); }
export function playUrl(id) { const p = store.get('profile'); return '/play/' + id + (p && p.userId ? '?p=' + encodeURIComponent(p.userId) : ''); }

// ---- TV hand-off: pick up on this device what a TV is playing ----
export async function getHandoff() { const d = await request('/api/handoff'); return d && d.playing ? d.playing : null; }
export function takeHandoff(device) { return request('/api/handoff/take', { method: 'POST', body: { device: device || '' } }); }
