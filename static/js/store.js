// Tiny state + event bus.
// Keys: me, profile, index, byId, relink.
// Events: index:updated, item:changed, route, modal:open, modal:close,
//         profile:updated (every set), profile:changed (userId differs), library:refresh.

const PROFILE_KEY = 'myflix.profile';

function readProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
    return p && typeof p === 'object' && p.userId ? p : null;
  } catch { return null; }
}
function writeProfile(p) {
  try {
    if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROFILE_KEY);
  } catch {}
}

const state = { me: null, profile: readProfile(), index: null, byId: new Map(), relink: null };
const listeners = new Map();

export function get(key) { return state[key]; }

export function set(key, val) {
  const prev = state[key];
  if (key === 'byId') return; // derived from index
  state[key] = val;
  if (key === 'index') {
    const m = new Map();
    if (Array.isArray(val)) for (const it of val) m.set(it.id, it);
    state.byId = m;
    emit('index:updated', val);
  } else if (key === 'profile') {
    writeProfile(val);
    const changed = (prev && prev.userId) !== (val && val.userId);
    if (changed) { state.index = null; state.byId = new Map(); }
    emit('profile:updated', val);
    if (changed) emit('profile:changed', val);
  }
}

export function on(evt, fn) {
  let set_ = listeners.get(evt);
  if (!set_) listeners.set(evt, (set_ = new Set()));
  set_.add(fn);
  return () => set_.delete(fn);
}

export function emit(evt, data) {
  if (evt === 'item:changed' && data && data.id != null) {
    const it = state.byId.get(data.id);
    if (it) {
      if ('played' in data) { it.played = !!data.played; if (!data.played) it.playedPct = 0; }
      if ('favorite' in data) it.favorite = !!data.favorite;
    }
  }
  const set_ = listeners.get(evt);
  if (!set_) return;
  for (const fn of [...set_]) {
    try { fn(data); } catch (e) { console.error('[store] listener for', evt, 'failed', e); }
  }
}
