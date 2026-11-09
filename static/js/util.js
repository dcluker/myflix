// Shared helpers. No dependencies (must stay a leaf module).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtRuntime(min) {
  const m = Math.round(Number(min) || 0);
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return r + 'm';
  return r === 0 ? h + 'h' : h + 'h ' + r + 'm';
}

export function fmtSeasons(n) {
  const k = Number(n) || 0;
  return k + (k === 1 ? ' Season' : ' Seasons');
}

export function debounce(fn, ms = 200) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(null, args); }, ms);
  };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = (...args) => { clearTimeout(t); t = null; fn.apply(null, args); };
  return d;
}

// el('div', {class:'x', dataset:{id:1}, style:{color:'red'}, onclick:fn}, 'text', childNode, [more])
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class' || k === 'className') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') {
        if (typeof v === 'string') node.style.cssText = v;
        else for (const [p, val] of Object.entries(v)) {
          if (p.includes('-')) node.style.setProperty(p, val);
          else node.style[p] = val;
        }
      } else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return node;
}

// ---- device detection -------------------------------------------------------
const TV_UA = /AFT|AFTS|AFTM|Silk.*TV|SmartTV|Android TV/i;
let tvCache = null;
export function isTV() {
  if (tvCache !== null) return tvCache;
  let v = false;
  try {
    const q = new URLSearchParams(location.search).get('tv');
    if (q === '1') { v = true; try { localStorage.setItem('myflix.tv', '1'); } catch {} }
    else if (q === '0') { v = false; try { localStorage.removeItem('myflix.tv'); } catch {} }
    else {
      v = TV_UA.test(navigator.userAgent || '');
      if (!v) { try { v = localStorage.getItem('myflix.tv') === '1'; } catch {} }
      else { try { localStorage.setItem('myflix.tv', '1'); } catch {} }
    }
  } catch {}
  tvCache = v;
  return v;
}

export function isTouch() {
  if (isTV()) return false;
  try {
    return window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
}

// ---- hash routing helpers (shared by app.js and nav.js) ----------------------
const ROUTES = new Set(['shows', 'movies', 'new', 'mylist', 'browse', 'live', 'settings', 'search', 'profiles', 'title']);
function dec(s) { try { return decodeURIComponent(s); } catch { return s; } }

// '#/browse?type=movie' -> {name:'browse', params:{type:'movie', name:'browse'}, path, hash}
export function parseHash(h = location.hash) {
  let s = String(h || '').replace(/^#/, '');
  if (!s.startsWith('/')) s = '/' + s;
  const qi = s.indexOf('?');
  const path = qi < 0 ? s : s.slice(0, qi);
  const qs = qi < 0 ? '' : s.slice(qi + 1);
  const params = Object.fromEntries(new URLSearchParams(qs));
  const seg = path.split('/').filter(Boolean).map(dec);
  let name = seg[0] || 'home';
  if (!ROUTES.has(name)) name = 'home';
  if (name === 'title') {
    if (!seg[1]) name = 'home';
    else params.id = seg[1];
  }
  params.name = name;
  const hash = name === 'home' ? '#/' + (qs ? '?' + qs : '') : '#' + path + (qs ? '?' + qs : '');
  return { name, params, path, hash };
}

// ---- toast ------------------------------------------------------------------
export function toast(msg, ms = 3200) {
  const root = document.getElementById('toast-root') || document.body;
  while (root.children.length >= 3) root.firstChild.remove();
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  root.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 450);
  }, ms);
}

// ---- icons (inline SVG strings, currentColor) ---------------------------------
const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  search: '<circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  gear: '<path fill="currentColor" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.9 2h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.61.22L2.68 8.48a.48.48 0 0 0 .12.64l2.03 1.58c-.04.31-.07.63-.07.94s.03.63.07.94L2.8 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.12.22.37.29.61.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96c.22.08.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>',
  send: '<path d="M21 3L3 10.5l6.5 2.5L12 20z M9.5 13L21 3" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  caret: '<path d="M7 10l5 5 5-5z" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2" fill="currentColor"/>',
  left: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  right: '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};
export function icon(name, size = 24) {
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

// Square profile avatar (image if available, else colored tile with initial).
const AV_COLORS = ['#0080e8', '#e5a00d', '#2fa84f', '#d81f26', '#8a6fe8', '#00a4a6'];
export function avatarEl(profile, cls = '') {
  const name = (profile && (profile.display || profile.name)) || '?';
  const av = profile && profile.avatar;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const emoji = av && av.kind === 'emoji' && av.emoji;
  const box = el('span', { class: ('avatar ' + cls).trim(), style: { background: emoji ? av.color : AV_COLORS[h % AV_COLORS.length] } },
    emoji ? el('span', { class: 'avatar-emoji' }, av.emoji) : el('span', { class: 'avatar-letter' }, name.charAt(0).toUpperCase()));
  // A chosen picture beats the Jellyfin one; a chosen emoji means no picture at all.
  const src = av && av.kind === 'photo' && av.url ? av.url : (!emoji && profile && profile.imageUrl) || null;
  if (src) {
    const img = el('img', { src, alt: '', draggable: 'false' });
    img.addEventListener('error', () => img.remove());
    box.appendChild(img);
  }
  return box;
}
