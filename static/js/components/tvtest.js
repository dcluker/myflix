// Full-screen picture test for any device (Settings -> Diagnostics). Solid colours, ramps, grids, 1px patterns, moving bars
// and the "Loading..." text at nine places, so a flaky panel or video chip shows exactly what breaks and where.
// Right / OK = next, Left = back, Up = hide the label, Down = auto-play, Back / Esc = leave.
const el = (h) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;inset:0'; d.innerHTML = h; return d; };
const solid = (c) => () => { const d = el(''); d.style.background = c; return d; };
const css = (d, s) => { d.style.cssText += ';' + s; return d; };

const PATTERNS = [
  ['Black', solid('#000')], ['White', solid('#fff')], ['Red', solid('#f00')], ['Green', solid('#0f0')], ['Blue', solid('#00f')], ['Gray 50%', solid('#808080')],
  ['Ramp left to right', () => css(el(''), 'background:linear-gradient(90deg,#000,#fff)')],
  ['Ramp top to bottom', () => css(el(''), 'background:linear-gradient(180deg,#000,#fff)')],
  ['Colour bars', () => css(el(['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'].map((c) => `<i style="flex:1;background:${c}"></i>`).join('')), 'display:flex')],
  ['Grid, corners and diagonals', () => {
    let t = '';
    for (let x = 0; x < innerWidth; x += 240) for (let y = 0; y < innerHeight; y += 240) t += `<b style="position:absolute;left:${x + 4}px;top:${y + 2}px;font:14px monospace;color:#ff0">${x},${y}</b>`;
    return css(el(t + '<div style="position:absolute;inset:0;background:linear-gradient(to top right,transparent calc(50% - 1px),#0ff,transparent calc(50% + 1px)),linear-gradient(to bottom right,transparent calc(50% - 1px),#f0f,transparent calc(50% + 1px))"></div>'),
      'background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:120px 120px;box-shadow:inset 0 0 0 3px #f00');
  }],
  ['"Loading..." at 9 places', () => {
    const pts = [[.03, .05], [.45, .05], [.82, .05], [.03, .5], [.45, .5], [.82, .5], [.03, .92], [.45, .92], [.82, .92]];
    return el(pts.map(([x, y]) => `<span style="position:absolute;left:${x * innerWidth}px;top:${y * innerHeight}px;font:700 34px Arial;color:#4aa8ff">Loading...</span>`).join(''));
  }],
  ['1px checkerboard', () => css(el(''), 'background:repeating-conic-gradient(#fff 0 25%,#000 0 50%) 0 0/2px 2px')],
  ['1px horizontal lines', () => css(el(''), 'background:repeating-linear-gradient(0deg,#fff 0 1px,#000 1px 2px)')],
  ['1px vertical lines', () => css(el(''), 'background:repeating-linear-gradient(90deg,#fff 0 1px,#000 1px 2px)')],
  ['Moving vertical bar', () => el('<div style="position:absolute;top:0;bottom:0;width:90px;left:0;background:#fff;animation:mftSweepX 3s linear infinite"></div>')],
  ['Moving horizontal bar', () => el('<div style="position:absolute;left:0;right:0;height:90px;top:0;background:#fff;animation:mftSweepY 3s linear infinite"></div>')],
  ['Flashing black / white', () => css(el(''), 'animation:mftFlash 1s steps(1) infinite')],
  ['Quadrants', () => css(el(['#f00', '#0f0', '#00f', '#fff'].map((c) => `<i style="background:${c}"></i>`).join('')), 'display:grid;grid-template:1fr 1fr/1fr 1fr')],
  ['Small text', () => css(el(('<p>The quick brown fox jumps over the lazy dog. 0123456789. '.repeat(3) + '</p>').repeat(24)), 'padding:30px;font:15px/1.4 Arial;column-count:3;color:#ddd')],
];

export function openPictureTest() {
  if (document.getElementById('mft')) return;
  const style = document.createElement('style');
  style.textContent = '@keyframes mftSweepX{from{transform:translateX(-120px)}to{transform:translateX(calc(100vw + 120px))}}'
    + '@keyframes mftSweepY{from{transform:translateY(-120px)}to{transform:translateY(calc(100vh + 120px))}}'
    + '@keyframes mftFlash{0%,49%{background:#000}50%,100%{background:#fff}}';
  const root = document.createElement('div');
  root.id = 'mft';
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;color:#fff;font-family:Arial,Helvetica,sans-serif;cursor:none';
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;inset:0';
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2;background:rgba(0,0,0,.78);border:2px solid #fff;padding:8px 14px;font-size:22px;line-height:1.25;border-radius:8px';
  root.append(stage, label);
  document.head.append(style);
  document.body.append(root);
  let i = 0, auto = 0, hide = false;
  const show = (n) => {
    i = (n + PATTERNS.length) % PATTERNS.length;
    stage.replaceChildren(PATTERNS[i][1]());
    label.innerHTML = `${i + 1} / ${PATTERNS.length}  ${PATTERNS[i][0]}<small style="display:block;font-size:15px;color:#bbb">${innerWidth}×${innerHeight} css px, ratio ${devicePixelRatio} · Right/OK next · Left back · Up hide label · Down auto-play · Back leave</small>`;
    label.style.display = hide ? 'none' : 'block';
  };
  const close = () => {
    clearInterval(auto);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.remove(); style.remove();
  };
  const onResize = () => show(i);
  function onKey(e) {
    const k = e.key;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || k === 'Backspace' || e.keyCode === 4) { swallow(); close(); }
    else if (k === 'ArrowRight' || k === 'Enter' || k === ' ' || e.keyCode === 23) { swallow(); show(i + 1); }
    else if (k === 'ArrowLeft') { swallow(); show(i - 1); }
    else if (k === 'ArrowUp') { swallow(); hide = !hide; label.style.display = hide ? 'none' : 'block'; }
    else if (k === 'ArrowDown') { swallow(); auto = auto ? (clearInterval(auto), 0) : setInterval(() => show(i + 1), 2500); }
    else swallow();
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  root.addEventListener('click', () => show(i + 1));
  show(0);
}
