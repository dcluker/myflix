// A colour picker that works with a TV remote: a large live preview with the hex code, and sliders for hue, saturation
// and lightness (Left/Right nudge, Up/Down move between them). The browser's own <input type=color> is tiny and does not
// exist on the Fire TV WebView. mode 'bg' is for the background colour: only hue and saturation matter there (the app
// derives the dark shades itself), so lightness is not offered and the preview shows the dark result.
import { el } from '../util.js';
import { hexToHsl, hslToHex, normalize } from '../theme.js';

const BG_L = 0.22;   // lightness stored for a background pick (the real backgrounds are derived much darker)

function slider(label, max, step, get, set, track) {
  const input = el('input', { type: 'range', class: 'cp-range', min: '0', max: String(max), step: String(step), 'aria-label': label });
  const row = el('label', { class: 'cp-row' }, el('span', { class: 'cp-lab' }, label), input);
  input.addEventListener('input', () => set(+input.value));
  input.addEventListener('keydown', (e) => {   // the TV navigation would move focus on Left/Right; nudge the value instead
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    input.value = String(Math.max(0, Math.min(max, +input.value + (e.key === 'ArrowRight' ? step : -step) * (e.repeat ? 3 : 1))));
    set(+input.value);
  });
  return { row, input, track, sync: () => { input.value = String(Math.round(get())); } };
}

export function colorPicker({ label, initial, mode = 'accent', onChange }) {
  let [h, s, l] = hexToHsl(initial || '#808080');
  if (mode === 'bg') l = BG_L;
  const swatch = el('span', { class: 'cp-swatch' });
  const hexEl = el('span', { class: 'cp-hex' });
  const caret = el('span', { class: 'cp-caret' }, '▸');
  const toggle = el('button', { class: 'cp-toggle', type: 'button', 'aria-expanded': 'false' }, swatch, hexEl, el('span', { class: 'cp-name' }, label), caret);
  const body = el('div', { class: 'cp-body', hidden: '' });
  const wrap = el('div', { class: 'cp' }, toggle, body);

  const value = () => hslToHex(h, s, l);
  const paint = () => {
    const hex = value();
    const shown = mode === 'bg' ? hslToHex(h, s < 0.04 ? 0 : Math.min(0.55, Math.max(0.15, s)), 0.1) : hex;   // what you will actually see
    swatch.style.background = shown;
    hexEl.textContent = mode === 'bg' ? 'background ' + hex : hex;
    wrap.style.setProperty('--cp-h', h);
    wrap.style.setProperty('--cp-s', Math.round(s * 100) + '%');
    wrap.style.setProperty('--cp-l', Math.round((mode === 'bg' ? 0.4 : l) * 100) + '%');
    hueS.sync(); satS.sync(); if (lightS) lightS.sync();
    hexIn.value = hex;
  };
  const emit = () => { paint(); if (onChange) onChange(value()); };

  // On a grey background pick, moving the hue should show something: give it some colour to work with.
  const hueS = slider('Colour', 360, 2, () => h, (v) => { h = v; if (mode === 'bg' && s < 0.04) s = 0.5; emit(); });
  const satS = slider('Intensity', 100, 2, () => s * 100, (v) => { s = v / 100; emit(); });
  const lightS = mode === 'bg' ? null : slider('Light / dark', 100, 2, () => l * 100, (v) => { l = v / 100; emit(); });
  hueS.input.classList.add('cp-hue'); satS.input.classList.add('cp-sat');
  if (lightS) lightS.input.classList.add('cp-light');
  const hexIn = el('input', { type: 'text', class: 'st-input cp-hexin', maxlength: '7', placeholder: '#rrggbb', 'aria-label': label + ' hex code', spellcheck: 'false' });
  hexIn.addEventListener('change', () => {
    const v = normalize(hexIn.value);
    if (!v) { hexIn.value = value(); return; }
    [h, s, l] = hexToHsl(v); if (mode === 'bg') l = BG_L;
    emit();
  });
  body.append(hueS.row, satS.row, ...(lightS ? [lightS.row] : []), hexIn);
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '▾' : '▸';
  });
  paint();
  return {
    node: wrap,
    // Set from outside (a preset was tapped): move the sliders without firing onChange.
    set(hex) { const v = normalize(hex); if (v) { [h, s, l] = hexToHsl(v); if (mode === 'bg') l = BG_L; } paint(); },
    value,
  };
}
