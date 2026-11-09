// Settings: theme (accent colour) and, in password mode, the sign-in password.
import * as store from '../store.js';
import { colorPicker } from '../components/colorpicker.js';
import { openPictureTest } from '../components/tvtest.js';
import { el, toast, avatarEl, isTV } from '../util.js';
import { getSettings, saveTheme, changePassword, signOut, customizeProfile, uploadProfilePhoto } from '../api.js';
import {
  PRESETS, SECONDARY_PRESETS, DEFAULT_ACCENT, applyAccent, currentAccent, setLocalAccent, normalize, initTheme,
  applySecondary, currentSecondary, setLocalSecondary, initSecondary, themeDefaults,
} from '../theme.js';

// One colour picker: swatches + a custom input. `presets` is [[name, hex|null]]; null = "stock" (black for the background).
function picker(label, help, presets, getPick, setPick, custom) {
  const swatches = el('div', { class: 'st-swatches', role: 'group', 'aria-label': label + ' presets' });
  const paint = (fromPicker) => {
    const cur = getPick();
    swatches.querySelectorAll('.st-sw').forEach((b) => b.setAttribute('aria-pressed', String((normalize(b.dataset.hex) || null) === (normalize(cur) || null))));
    if (custom && !fromPicker) custom.set(normalize(cur) || custom.fallback);   // not while the sliders are being dragged (would fight them)
  };
  for (const [name, hex] of presets) {
    swatches.append(el('button', { class: 'st-sw', type: 'button', 'data-hex': hex || '', 'aria-pressed': 'false', 'aria-label': name, title: name,
      onclick: () => { setPick(hex); paint(); } },
      el('span', { class: 'st-dot', style: `background:${hex || '#000'}` }), el('span', { class: 'st-sw-name' }, name)));
  }
  return { node: el('div', { class: 'st-pick' }, el('h3', { class: 'st-sub' }, label), el('p', { class: 'st-help' }, help), swatches), paint };
}

// The signed-in profile as the server knows it (picture, display name, own theme), and a way to push a change back
// into the shared state so the nav avatar and the picker repaint.
const curId = () => (store.get('profile') || {}).userId;
const fullProfile = () => (((store.get('me') || {}).profiles) || []).find((p) => p.userId === curId()) || null;
function mergeProfile(updated) {
  const me = store.get('me') || { profiles: [] };
  me.profiles = (me.profiles || []).map((p) => (p.userId === updated.userId ? { ...p, ...updated, display: updated.display, avatar: updated.avatar, theme: updated.theme } : p));
  store.set('me', me);
  store.emit('profile:updated', store.get('profile'));
}

function themeCard(st) {
  const canGlobal = !!st.canSetGlobalTheme;   // only a Jellyfin administrator (the admin account and the like) may set it for everyone
  const dflt = () => themeDefaults(store.get('me'), curId());   // what this profile starts from, before a device override
  let accent = currentAccent(dflt().accent);
  let second = currentSecondary(dflt().secondary);   // null = black
  let scope = 'device';                               // 'device' | 'profile' | 'everyone'
  const msg = el('p', { class: 'st-msg', role: 'status', 'aria-live': 'polite' });

  const cA = colorPicker({ label: 'Custom colour', initial: accent, onChange: (hex) => { accent = normalize(hex); applyAccent(accent); pa.paint(true); } });
  const cS = colorPicker({ label: 'Custom colour', initial: second || '#141414', mode: 'bg', onChange: (hex) => { second = normalize(hex); applySecondary(second); ps.paint(true); } });
  cA.fallback = DEFAULT_ACCENT; cS.fallback = '#141414';
  const pa = picker('Main colour', 'Buttons, the logo, highlights and glows.', PRESETS, () => accent,
    (hex) => { accent = normalize(hex) || DEFAULT_ACCENT; applyAccent(accent); msg.textContent = ''; }, cA);
  const ps = picker('Background', 'Replaces the black behind everything. Black is the stock look.', SECONDARY_PRESETS, () => second,
    (hex) => { second = normalize(hex); applySecondary(second); msg.textContent = ''; }, cS);

  const scopes = [['device', 'This device'], ['profile', 'This profile (every device)']];
  if (canGlobal) scopes.push(['everyone', 'Everyone (all profiles and devices)']);
  const scopeBox = el('div', { class: 'st-scope', role: 'radiogroup', 'aria-label': 'Where to save' },
    ...scopes.map(([k, label]) => el('label', { class: 'st-check' },
      el('input', { type: 'radio', name: 'st-scope', value: k, checked: k === scope, onchange: () => { scope = k; } }), el('span', null, label))));
  const stockA = (v) => (v === DEFAULT_ACCENT ? null : v);
  const reapply = () => { const d = dflt(); initTheme(d.accent); initSecondary(d.secondary); };

  const save = el('button', { class: 'st-btn st-primary', type: 'button', onclick: async () => {
    try {
      if (scope === 'everyone') {
        await saveTheme({ accent: stockA(accent), secondary: second });
        const me = store.get('me') || {}; me.theme = { accent: stockA(accent), secondary: second }; store.set('me', me);
        setLocalAccent(null); setLocalSecondary(null); reapply();
        msg.textContent = 'Saved for everyone.';
      } else if (scope === 'profile') {
        const theme = {};
        if (stockA(accent)) theme.accent = stockA(accent);
        if (second) theme.secondary = second;
        const p = await customizeProfile({ userId: curId(), theme: Object.keys(theme).length ? theme : null });
        mergeProfile(p); setLocalAccent(null); setLocalSecondary(null); reapply();
        msg.textContent = 'Saved for this profile.';
      } else { setLocalAccent(stockA(accent)); setLocalSecondary(second); msg.textContent = 'Saved on this device.'; }
    } catch (e) { msg.textContent = 'Could not save: ' + ((e && e.message) || 'error'); }
  } }, 'Save');
  const reset = el('button', { class: 'st-btn', type: 'button', onclick: async () => {
    try {
      setLocalAccent(null); setLocalSecondary(null);
      if (scope === 'everyone') { await saveTheme({ accent: null, secondary: null }); const me = store.get('me') || {}; me.theme = {}; store.set('me', me); }
      else if (scope === 'profile') { mergeProfile(await customizeProfile({ userId: curId(), theme: null })); }
      reapply();
      const d = dflt(); accent = currentAccent(d.accent); second = currentSecondary(d.secondary);
      pa.paint(); ps.paint();
      msg.textContent = 'Back to the default.';
    } catch (e) { msg.textContent = 'Could not reset: ' + ((e && e.message) || 'error'); }
  } }, 'Reset');
  pa.paint(); ps.paint();
  return el('section', { class: 'st-card' },
    el('h2', null, 'Theme'),
    el('p', { class: 'st-help' }, 'Changes show live; choose where to save, then press Save.'),
    pa.node, cA.node,
    ps.node, cS.node,
    scopeBox, el('div', { class: 'st-row' }, save, reset), msg);
}

// Stick to emoji from 2018 or earlier: the Fire TV's system font (Android 9) shows newer ones as empty boxes.
const EMOJI_SETS = [
  ['Faces', '😀 😄 😁 😆 😂 🤣 😊 😇 🙂 😉 😍 🤩 😘 😜 🤪 😝 🤑 🤗 🤔 🤫 🤐 😏 😴 😎 🤓 🧐 🥳 🥰 🥺 😤 😭 😱 🤯 😈 🤠 🤡'],
  ['People', '👶 👦 👧 🧒 👨 👩 🧑 👴 👵 🧔 👱 👸 🤴 👮 👷 💂 🕵️ 🧙 🧚 🧛 🧜 🧝 🧞 🧟 🦸 🦹 🎅 🤶 👰 🤵 💃 🕺 🙋 🤷 🤦'],
  ['Animals', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐬 🐳 🦈 🐘 🦒 🦓 🦍 🦘 🦔'],
  ['Food', '🍕 🍔 🍟 🌭 🌮 🌯 🍿 🍩 🍪 🎂 🍰 🍫 🍬 🍭 🍦 🍉 🍓 🍒 🍌 🍍 🥑 🌽 🌶️ 🍄 🥨 🥓 🍣 🍜 🍳 ☕ 🍺 🍷 🍹 🥤 🧀'],
  ['Sports', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 🏑 🥊 🥋 ⛳ 🏹 🎣 🎿 🏂 🏄 🏊 🚴 🏇 🏋️ 🤸 🏆 🥇 🏁 🥍'],
  ['Fun', '🎮 🕹️ 🎲 🧩 🎯 🎳 🎬 🎥 📺 🎧 🎤 🎸 🥁 🎹 🎺 🎷 🎨 🎭 🎪 🎉 🎈 🎁 🃏 🧸 🔮 🎩 👑 💎 💰 💡 📚 🔑 🔥 ⚡ 💥 💯'],
  ['Nature', '🌟 ⭐ 🌙 ☀️ 🌈 ☁️ ⛈️ ❄️ ☃️ 🌊 🌋 🏔️ 🏕️ 🏝️ 🌵 🌴 🌲 🌳 🍀 🍁 🌻 🌹 🌷 🌸 🌎'],
  ['Space & more', '🚀 🛸 🛰️ 👽 👾 🤖 👻 💀 ☠️ 🎃 🐉 🦖 🦕 ⚔️ 🛡️ 🏰 🗿 🚗 🏎️ 🚓 🚒 🚜 🏍️ ✈️ 🚁 🚢 🚂 ⚓ 🗽 🗼'],
].map(([name, list]) => [name, list.split(' ').filter(Boolean)]);
const AV_PALETTE = ['#0080e8', '#14213d', '#1b4965', '#00a4a6', '#0f8b8d', '#2fa84f', '#16302b', '#7cb518', '#e5a00d', '#e8590c',
  '#d81f26', '#64212f', '#d6336c', '#ff85a1', '#8a6fe8', '#4b2e83', '#6d4c41', '#37474f', '#9e9e9e', '#111111'];

// Resize a picked photo to a 256px square JPEG in the browser, so uploads stay small whatever the camera made.
function squareJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const S = 256, side = Math.min(img.width, img.height);
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      cv.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('could not read the picture'))), 'image/jpeg', 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not a picture')); };
    img.src = url;
  });
}

function profileCard() {
  const msg = el('p', { class: 'st-msg', role: 'status', 'aria-live': 'polite' });
  const preview = el('span', { class: 'st-av' });
  const nameIn = el('input', { type: 'text', class: 'st-input', maxlength: '24', placeholder: 'Display name', 'aria-label': 'Display name' });
  let color = AV_PALETTE[0];
  const paint = () => {
    const p = fullProfile();
    preview.replaceChildren(avatarEl(p, 'lg'));
    nameIn.value = (p && (p.display || '')) || '';
    const av = p && p.avatar;
    if (av && av.kind === 'emoji') color = av.color;
    card.querySelectorAll('.st-emoji').forEach((b) => b.setAttribute('aria-pressed', String(!!(av && av.kind === 'emoji' && av.emoji === b.dataset.e))));
    card.querySelectorAll('.st-col').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === color)));
  };
  const run = async (fn, ok) => {
    try { mergeProfile(await fn()); paint(); msg.textContent = ok; }
    catch (e) { msg.textContent = e && e.status === 400 ? 'That is not an emoji.' : e && e.code === 'unsupported_image' ? 'Use a JPEG, PNG or WebP picture.' : 'Could not save: ' + ((e && e.message) || 'error'); }
  };
  const setAvatar = (emoji, c) => run(() => customizeProfile({ userId: curId(), avatar: { kind: 'emoji', emoji, color: c } }), 'Picture saved.');

  const cur0 = ((fullProfile() || {}).avatar || {}).emoji;
  let setIdx = Math.max(0, EMOJI_SETS.findIndex(([, l]) => l.includes(cur0)));
  const emojis = el('div', { class: 'st-emojis', role: 'group', 'aria-label': 'Emoji picture' });
  const tabs = el('div', { class: 'st-tabs', role: 'group', 'aria-label': 'Emoji categories' });
  const showSet = (i) => {   // only one category is in the page at a time, so the remote has a short walk
    setIdx = i;
    emojis.replaceChildren(...EMOJI_SETS[i][1].map((e) => el('button', { class: 'st-emoji', type: 'button', 'data-e': e, 'aria-label': e, 'aria-pressed': 'false', onclick: () => setAvatar(e, color) }, e)));
    tabs.querySelectorAll('.st-tab').forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
  };
  tabs.append(...EMOJI_SETS.map(([name], i) => el('button', { class: 'st-tab', type: 'button', 'aria-pressed': 'false', onclick: () => { showSet(i); paint(); } }, name)));
  const anyIn = el('input', { type: 'text', class: 'st-input st-any', maxlength: '16', placeholder: 'Or type any emoji', 'aria-label': 'Type any emoji' });
  const anyGo = el('button', { class: 'st-btn', type: 'button', onclick: () => { const v = anyIn.value.trim(); if (v) { setAvatar(v, color); anyIn.value = ''; } } }, 'Use it');
  const colors = el('div', { class: 'st-cols', role: 'group', 'aria-label': 'Picture colour' },
    ...AV_PALETTE.map((c) => el('button', { class: 'st-col', type: 'button', 'data-c': c, 'aria-label': c, 'aria-pressed': 'false', style: `background:${c}`,
      onclick: () => {
        color = c;
        const av = (fullProfile() || {}).avatar;
        if (av && av.kind === 'emoji') setAvatar(av.emoji, c); else { paint(); msg.textContent = 'Pick an emoji first, then a colour.'; }
      } })));
  const file = el('input', { type: 'file', accept: 'image/*', class: 'st-file', hidden: '' });
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (f) run(async () => uploadProfilePhoto(curId(), await squareJpeg(f)), 'Photo saved.');
  });
  const buttons = el('div', { class: 'st-row' },
    isTV() ? null : el('button', { class: 'st-btn', type: 'button', onclick: () => file.click() }, 'Upload photo'),
    el('button', { class: 'st-btn', type: 'button', onclick: () => run(() => customizeProfile({ userId: curId(), avatar: { kind: 'letter' } }), 'Back to the letter.') }, 'Use letter'), file);
  const saveName = el('button', { class: 'st-btn st-primary', type: 'button', onclick: () => run(() => customizeProfile({ userId: curId(), display: nameIn.value }), 'Name saved.') }, 'Save name');
  const card = el('section', { class: 'st-card' }, el('h2', null, 'Profile'),
    el('p', { class: 'st-help' }, 'Your name and picture. The Jellyfin sign-in name does not change.'),
    el('div', { class: 'st-profile-top' }, preview, el('div', { class: 'st-profile-name' }, nameIn, saveName)),
    el('h3', { class: 'st-sub' }, 'Picture'), tabs, emojis, el('div', { class: 'st-row st-anyrow' }, anyIn, anyGo), el('h3', { class: 'st-sub' }, 'Colour behind it'), colors, buttons, msg);
  showSet(setIdx);
  paint();
  return card;
}

function diagnosticsCard() {
  return el('section', { class: 'st-card' }, el('h2', null, 'Diagnostics'),
    el('p', { class: 'st-help' }, 'Picture test: full-screen colours, grids, 1-pixel patterns, moving bars and text. Use it when a TV shows tearing, smears or ghosting, ' +
      'to see which patterns break and where. Right / OK = next, Left = back, Back = leave.'),
    el('div', { class: 'st-row' }, el('button', { class: 'st-btn st-primary', type: 'button', onclick: () => openPictureTest() }, 'Run picture test')));
}

function signInCard(st) {
  const a = st.auth || {};
  const modeText = a.mode === 'password' ? 'Password' : a.mode === 'cloudflare' ? 'Cloudflare Access' : 'Development (no sign-in)';
  // No buttons in here under Cloudflare, so the remote could never reach (or scroll to) this card: make the card itself a stop.
  const card = el('section', { class: 'st-card', tabindex: a.canChangePassword ? null : '0' }, el('h2', null, 'Sign-in'),
    el('p', { class: 'st-help' }, 'Method: ', el('strong', null, modeText),
      '. The method is chosen when MyFlix starts (MYFLIX_AUTH in .env); it cannot be switched off from here, so the server can never be left open by accident.'));
  if (!a.canChangePassword) return card;
  const cur = el('input', { type: 'password', class: 'st-input', placeholder: 'Current password', autocomplete: 'current-password' });
  const nw = el('input', { type: 'password', class: 'st-input', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const msg = el('p', { class: 'st-msg', role: 'status', 'aria-live': 'polite' });
  const go = el('button', { class: 'st-btn st-primary', type: 'button', onclick: async () => {
    if ((nw.value || '').length < 8) { msg.textContent = 'The new password needs at least 8 characters.'; return; }
    try {
      await changePassword(cur.value, nw.value);
      cur.value = ''; nw.value = '';
      msg.textContent = 'Password changed. Other browsers are signed out.';
    } catch (e) {
      msg.textContent = e && e.code === 'wrong_password' ? 'Current password is wrong.'
        : e && e.status === 429 ? 'Too many tries. Wait a few minutes.' : 'Could not change it.';
    }
  } }, 'Change password');
  card.append(cur, nw, el('div', { class: 'st-row' }, go,
    el('button', { class: 'st-btn', type: 'button', onclick: () => signOut() }, 'Sign out')), msg);
  return card;
}

export async function render(container) {
  const root = el('div', { class: 'st' }, el('h1', { class: 'st-h1' }, 'Settings'));
  container.appendChild(root);
  let st;
  try { st = await getSettings(); } catch { toast('Could not load settings'); return; }
  root.append(profileCard(), themeCard(st), diagnosticsCard(), signInCard(st));
  // Leaving without saving: put the saved colour back.
  return () => { applyAccent(currentAccent(st.theme && st.theme.accent)); applySecondary(currentSecondary(st.theme && st.theme.secondary)); };
}
