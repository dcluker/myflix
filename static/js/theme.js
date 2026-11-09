// Accent colour ("primary"): presets + custom, per device (localStorage) with an optional owner-set default for everyone.
// Everything that was MyFlix red is driven by --red / --red-hover / --red-rgb, so changing those three recolours the app.
const KEY = 'myflix.accent';
export const DEFAULT_ACCENT = '#e50914';
export const PRESETS = [
  ['Red', '#e50914'], ['Burgundy', '#800020'], ['Maroon', '#64212f'], ['Crimson', '#b0102a'], ['Orange', '#e8590c'], ['Gold', '#c98a00'],
  ['Green', '#1f9d55'], ['Teal', '#0f8b8d'], ['Blue', '#2563eb'], ['Purple', '#7c3aed'], ['Pink', '#d6336c'],
];

export function normalize(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}

function toHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s, l];
}

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

const hex2 = (v) => v.toString(16).padStart(2, '0');

// Text on the accent is white, so very light colours are darkened until it stays readable.
export function palette(hex) {
  const ok = normalize(hex) || DEFAULT_ACCENT;
  let [h, s, l] = toHsl(ok);
  if (l > 0.5) l = 0.5;
  const base = fromHsl(h, s, l);
  const hover = fromHsl(h, s, Math.min(0.62, l + 0.05));
  return { base: '#' + base.map(hex2).join(''), hover: '#' + hover.map(hex2).join(''), rgb: base.join(', ') };
}

export function applyAccent(hex) {
  const p = palette(hex);
  const st = document.documentElement.style;
  st.setProperty('--red', p.base);
  st.setProperty('--red-hover', p.hover);
  st.setProperty('--red-rgb', p.rgb);
  return p.base;
}

export function localAccent() {
  try { return normalize(localStorage.getItem(KEY)); } catch { return null; }
}

export function setLocalAccent(hex) {
  try {
    if (hex) localStorage.setItem(KEY, normalize(hex)); else localStorage.removeItem(KEY);
  } catch {}
}

// This device's choice wins; otherwise the owner's default; otherwise the stock red.
export function currentAccent(serverAccent) {
  return localAccent() || normalize(serverAccent) || DEFAULT_ACCENT;
}

export function initTheme(serverAccent) {
  try { if (serverAccent !== undefined) localStorage.setItem(KEY + '.server', normalize(serverAccent) || ''); } catch {}
  applyAccent(currentAccent(serverAccent === undefined ? cachedServer() : serverAccent));
}

function cachedServer() {
  try { return localStorage.getItem(KEY + '.server') || null; } catch { return null; }
}

// Paint the last known theme immediately (before any network call) so there is no flash of red.
applyAccent(currentAccent(cachedServer()));

// ---- secondary colour: replaces the black of the backgrounds ------------------------------------------------------
// null = stock black. Otherwise the hue (and a little of the saturation) of the pick is spread over the background tokens.
const SKEY = 'myflix.secondary';
export const SECONDARY_PRESETS = [
  ['Black', null], ['Charcoal', '#2b2d31'], ['Navy', '#14213d'], ['Midnight', '#1b1b3a'], ['Forest', '#16302b'],
  ['Plum', '#35193e'], ['Wine', '#3a1520'], ['Slate', '#263238'], ['Espresso', '#2e1f1a'],
];
const BG_VARS = ['--bg', '--bg-elev', '--bg-card', '--bg-raised', '--bg-deep', '--bg-rgb', '--bg-elev-rgb', '--bg-deep-rgb'];

export function applySecondary(hex) {
  const st = document.documentElement.style;
  const ok = normalize(hex);
  if (!ok) { BG_VARS.forEach((v) => st.removeProperty(v)); return null; }
  const [h, s0] = toHsl(ok);
  const sat = s0 < 0.04 ? 0 : Math.min(0.55, Math.max(0.15, s0));   // a true grey stays neutral (hue is meaningless there)
  const at = (l) => fromHsl(h, sat, l);
  const css = (rgb) => '#' + rgb.map(hex2).join('');
  const bg = at(0.075), elev = at(0.095);
  st.setProperty('--bg', css(bg));
  st.setProperty('--bg-elev', css(elev));
  st.setProperty('--bg-card', css(at(0.17)));
  st.setProperty('--bg-raised', css(at(0.14)));
  const deep = at(0.035);
  st.setProperty('--bg-deep', css(deep));
  st.setProperty('--bg-deep-rgb', deep.join(', '));
  st.setProperty('--bg-rgb', bg.join(', '));
  st.setProperty('--bg-elev-rgb', elev.join(', '));
  return ok;
}

export function localSecondary() {
  try { return normalize(localStorage.getItem(SKEY)); } catch { return null; }
}

export function setLocalSecondary(hex) {
  try {
    if (hex) localStorage.setItem(SKEY, normalize(hex)); else localStorage.removeItem(SKEY);
  } catch {}
}

function cachedServerSecondary() {
  try { return localStorage.getItem(SKEY + '.server') || null; } catch { return null; }
}

export function currentSecondary(serverSecondary) {
  return localSecondary() || normalize(serverSecondary) || null;
}

export function initSecondary(serverSecondary) {
  try { if (serverSecondary !== undefined) localStorage.setItem(SKEY + '.server', normalize(serverSecondary) || ''); } catch {}
  applySecondary(currentSecondary(serverSecondary === undefined ? cachedServerSecondary() : serverSecondary));
}

applySecondary(currentSecondary(cachedServerSecondary()));   // no flash of black before the first network call

// The theme a profile starts from (before this device's own override): the profile's own, else the owner's default.
export function themeDefaults(me, userId) {
  const p = userId && ((me && me.profiles) || []).find((x) => x.userId === userId);
  const pt = (p && p.theme) || {};
  const gt = (me && me.theme) || {};
  return { accent: pt.accent || gt.accent || null, secondary: pt.secondary || gt.secondary || null };
}

export const hexToHsl = (hex) => toHsl(normalize(hex) || DEFAULT_ACCENT);
export const hslToHex = (h, sat, l) => '#' + fromHsl(((h % 360) + 360) % 360, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, l))).map(hex2).join('');
