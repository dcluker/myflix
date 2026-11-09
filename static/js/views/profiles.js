// "Who's watching?" profile picker + link form.
//   list    - pick a profile, "Add Profile", "Manage Profiles"
//   manage  - tap a profile to unlink it (inline confirmation, no window.confirm)
//   link    - Jellyfin username/password form (first run, Add Profile, or re-link after expiry)
import * as store from '../store.js';
import '../vendor/qrcode.js';   // MIT, kazuhikoarase/qrcode-generator; sets window.qrcode
import { getMe, linkProfile, unlinkProfile, createLinkSession, pollLinkSession } from '../api.js';
import { el, avatarEl, icon, toast, isTV } from '../util.js';

function isBackKey(e) {
  if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 4) return true;
  if (e.key === 'Backspace') {
    const t = e.target;
    const tag = t && t.tagName;
    return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable));
  }
  return false;
}

export function render(container) {
  let alive = true;
  let mode = 'list';        // 'list' | 'manage' | 'link'
  let confirmId = null;     // userId waiting for the inline "Remove" confirmation
  let busy = false;
  let link = null;          // {prefill, relinkId, notice}
  let focusSel = null;      // selector to focus after the next paint
  let relinkId = store.get('relink') || null;

  const root = el('div', { class: 'pf' });
  container.appendChild(root);

  const profiles = () => ((store.get('me') || {}).profiles) || [];
  const profileKey = () => profiles().map((x) => x.userId + ':' + x.name).join('|');
  let renderedKey = '';

  if (!profiles().length) { mode = 'link'; link = { prefill: '', relinkId: null, notice: '' }; }
  else if (relinkId && relinkId !== true) {
    const p = profiles().find((x) => x.userId === relinkId);
    if (p) { mode = 'link'; link = { prefill: p.name || '', relinkId: p.userId, notice: 'Your sign-in for ' + (p.name || 'this profile') + ' expired. Sign in again to continue.' }; }
  }

  // ---- actions --------------------------------------------------------------------------
  function choose(p) {
    if (busy) return;
    if (relinkId && relinkId === p.userId) {
      openLink({ prefill: p.name || '', relinkId: p.userId, notice: 'Your sign-in for ' + (p.name || 'this profile') + ' expired. Sign in again to continue.' });
      return;
    }
    enter(p);
  }

  function enter(p) {
    try { sessionStorage.setItem('mf_picked', '1'); } catch {}
    store.set('relink', null);
    store.set('profile', { userId: p.userId, name: p.name, imageUrl: p.imageUrl || null });
    location.hash = '#/';
  }

  function openLink(opts) {
    mode = 'link';
    link = Object.assign({ prefill: '', relinkId: null, notice: '' }, opts || {});
    confirmId = null;
    focusSel = link.prefill ? 'input[name="password"]' : 'input[name="username"]';
    paint();
  }

  function backToList() {
    mode = 'list';
    link = null;
    confirmId = null;
    focusSel = '.pf-tile';
    paint();
  }

  async function remove(p) {
    if (busy) return;
    busy = true;
    paint();
    try {
      await unlinkProfile(p.userId);
      if (!alive) return;
      toast('Removed ' + (p.name || 'profile'));
      if (relinkId === p.userId) { relinkId = null; store.set('relink', null); }
    } catch (e) {
      if (!alive) return;
      toast('Could not remove that profile');
    } finally {
      busy = false;
    }
    if (!alive) return;
    confirmId = null;
    if (!profiles().length) { mode = 'link'; link = { prefill: '', relinkId: null, notice: '' }; focusSel = 'input[name="username"]'; }
    else focusSel = '.pf-manage';
    paint();
  }

  // ---- list view -------------------------------------------------------------------------
  function tile(p) {
    const isManage = mode === 'manage';
    const needsRelink = relinkId && relinkId === p.userId;

    if (confirmId === p.userId) {
      return el('li', { class: 'pf-item is-confirm' },
        el('span', { class: 'pf-av is-dim' }, avatarEl(p, 'lg')),
        el('span', { class: 'pf-name pf-confirm-q' }, 'Remove ' + (p.display || p.name || 'profile') + '?'),
        el('span', { class: 'pf-confirm' },
          el('button', { class: 'pf-btn danger', type: 'button', 'data-confirm': 'yes', disabled: busy, onclick: () => remove(p) }, busy ? 'Removing' : 'Remove'),
          el('button', { class: 'pf-btn', type: 'button', 'data-confirm': 'no', disabled: busy, onclick: () => { confirmId = null; focusSel = '.pf-tile[data-id="' + p.userId + '"]'; paint(); } }, 'Cancel')),
        el('span', { class: 'pf-hint' }, 'Signs this profile out of MyFlix only.'));
    }

    const av = el('span', { class: 'pf-av' }, avatarEl(p, 'lg'));
    if (isManage) av.appendChild(el('span', { class: 'pf-av-ov', html: icon('close', 40) }));
    const cap = [el('span', { class: 'pf-name' }, p.display || p.name || 'Profile')];
    if (needsRelink) cap.push(el('span', { class: 'pf-flag' }, 'Sign in again'));
    return el('li', { class: 'pf-item' },
      el('button', {
        class: 'pf-tile', type: 'button', 'data-id': p.userId,
        'aria-label': isManage ? 'Remove ' + (p.display || p.name || 'profile') : (p.display || p.name || 'Profile'),
        onclick: () => {
          if (busy) return;
          if (isManage) { confirmId = p.userId; focusSel = '[data-confirm="no"]'; paint(); }
          else choose(p);
        },
      }, av, cap));
  }

  function addTile() {
    return el('li', { class: 'pf-item' },
      el('button', { class: 'pf-tile pf-add', type: 'button', 'aria-label': 'Add Profile', onclick: () => { if (!busy) openLink(); } },
        el('span', { class: 'pf-av' }, el('span', { class: 'avatar lg pf-add-av', html: icon('plus', 56) })),
        el('span', { class: 'pf-name' }, 'Add Profile')));
  }

  function listView() {
    const manage = mode === 'manage';
    const items = profiles().map(tile);
    // Accounts that exist on the server but are not signed in on this device (owners only): shown dimmed,
    // pressing one opens the sign-in form with the name filled in.
    if (!manage) {
      for (const o of ((store.get('me') || {}).others || [])) {
        items.push(el('li', { class: 'pf-item' },
          el('button', {
            class: 'pf-tile', type: 'button', 'data-id': o.userId, 'aria-label': o.name + ' (sign in)',
            onclick: () => { if (!busy) openLink({ prefill: o.name }); },
          }, el('span', { class: 'pf-av is-dim' }, avatarEl(o, 'lg')),
          [el('span', { class: 'pf-name' }, o.name), el('span', { class: 'pf-flag' }, 'Sign in')])));
      }
    }
    items.push(addTile());
    return el('div', { class: 'pf-list' },
      el('h1', { class: 'pf-title' }, manage ? 'Manage Profiles:' : "Who’s watching?"),
      el('ul', { class: 'pf-grid', role: 'list' }, items),
      el('button', {
        class: 'pf-manage' + (manage ? ' is-done' : ''), type: 'button',
        onclick: () => { if (busy) return; mode = manage ? 'list' : 'manage'; confirmId = null; focusSel = '.pf-manage'; paint(); },
      }, manage ? 'Done' : 'Manage Profiles'));
  }

  // ---- link view --------------------------------------------------------------------------
  function linkView() {
    const first = !profiles().length;
    const relink = !!(link && link.relinkId);
    const user = el('input', {
      class: 'pf-input', name: 'username', type: 'text', placeholder: 'Jellyfin username', 'aria-label': 'Jellyfin username',
      autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', required: true,
      value: (link && link.prefill) || '',
    });
    const pass = el('input', {
      class: 'pf-input', name: 'password', type: 'password', placeholder: 'Password', 'aria-label': 'Jellyfin password',
      autocomplete: 'current-password', enterkeyhint: 'go', required: true,
    });
    const err = el('div', { class: 'pf-err', role: 'alert', hidden: true });
    const submit = el('button', { class: 'pf-submit', type: 'submit' }, relink ? 'Sign in' : 'Link profile');

    const showErr = (msg) => { err.textContent = msg; err.hidden = !msg; };
    const setPending = (on) => {
      user.disabled = on; pass.disabled = on; submit.disabled = on;
      submit.textContent = on ? 'Linking…' : (relink ? 'Sign in' : 'Link profile');
    };

    const form = el('form', {
      class: 'pf-form', autocomplete: 'on', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        const u = user.value.trim();
        const pw = pass.value;
        if (!u || !pw) { showErr('Enter your Jellyfin username and password.'); (u ? pass : user).focus(); return; }
        busy = true;
        showErr('');
        setPending(true);
        let prof = null;
        let failed = null;
        try { prof = await linkProfile(u, pw); }
        catch (ex) { failed = ex; }
        pass.value = '';
        busy = false;
        if (!alive) return;
        if (failed) {
          setPending(false);
          if (failed.status === 429) showErr('Too many attempts. Wait a minute and try again.');
          else if (failed.code === 'bad_credentials' || failed.status === 400) showErr('Wrong username or password.');
          else showErr('Could not reach MyFlix. Try again in a moment.');
          pass.focus();
          return;
        }
        const me = store.get('me') || { profiles: [] };
        const made = (prof && prof.userId && (me.profiles || []).find((x) => x.userId === prof.userId))
          || (me.profiles || []).find((x) => x.name === (prof && prof.name || u))
          || prof;
        const auto = first || relink;
        if (relinkId && (relinkId === true || (made && relinkId === made.userId))) { relinkId = null; store.set('relink', null); }
        if (auto && made && made.userId) { enter(made); return; }
        toast('Added ' + ((made && made.name) || u));
        mode = 'list';
        link = null;
        focusSel = made && made.userId ? '.pf-tile[data-id="' + made.userId + '"]' : '.pf-tile';
        paint();
      },
    },
    user, pass, err, submit);

    const heading = relink ? 'Sign in again' : (first ? 'Link your Jellyfin account' : 'Add Profile');
    const sub = (link && link.notice)
      || (first ? 'MyFlix shows your Jellyfin library. Sign in once and this browser remembers you.'
        : 'Link another Jellyfin user to your MyFlix account.');

    const card = el('div', { class: 'pf-card' },
      el('h1', null, heading),
      el('p', { class: 'pf-sub' }, sub),
      form,
      el('p', { class: 'pf-note' }, 'Your password is only used to sign in to Jellyfin. MyFlix keeps a sign-in token, not the password.'));
    if (isTV()) card.appendChild(phoneBox());
    if (!first) card.appendChild(el('button', { class: 'pf-cancel', type: 'button', onclick: backToList }, 'Cancel'));
    return card;
  }

  // ---- sign in from a phone (TV only) -------------------------------------------------------
  let phoneTimer = 0;
  function stopPhone() { clearInterval(phoneTimer); phoneTimer = 0; }
  function phoneBox() {
    stopPhone();
    const box = el('div', { class: 'pf-phone' });
    const qrSlot = el('div', { class: 'pf-qr' });
    const text = el('div', { class: 'pf-phone-text' },
      el('strong', null, 'Or sign in from your phone'),
      el('span', { class: 'pf-phone-msg' }, 'Getting a code\u2026'));
    box.append(qrSlot, text);
    const msg = () => text.querySelector('.pf-phone-msg');
    (async () => {
      let s;
      try { s = await createLinkSession(); } catch { msg().textContent = 'Phone sign-in is not available right now.'; return; }
      if (!alive || mode !== 'link') return;
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(s.url);
        qr.make();
        qrSlot.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch { /* the code below still works by typing the address */ }
      msg().replaceChildren('Scan this with your phone camera, then type the username and password there.', el('br'),
        'Code ', el('b', { class: 'pf-code' }, s.code));
      phoneTimer = setInterval(async () => {
        if (!alive || mode !== 'link') { stopPhone(); return; }
        let d = null;
        try { d = await pollLinkSession(s.code); } catch (e) { if (e && e.status === 404) { stopPhone(); msg().textContent = 'That code expired. Go back and open sign-in again.'; } return; }
        if (d && d.status === 'done') {
          stopPhone();
          try { await getMe(); } catch {}
          const me = store.get('me') || { profiles: [] };
          const made = (me.profiles || []).find((x) => x.userId === d.userId);
          toast('Signed in as ' + ((made && made.name) || d.name || 'new profile'));
          if (made) { enter(made); return; }
          mode = 'list'; link = null; paint();
        }
      }, 2000);
    })();
    return box;
  }

  // ---- paint ------------------------------------------------------------------------------
  function paint() {
    renderedKey = profileKey();
    if (mode !== 'link') stopPhone();
    root.innerHTML = '';
    root.classList.toggle('is-link', mode === 'link');
    root.appendChild(mode === 'link' ? linkView() : listView());
    const sel = focusSel;
    focusSel = null;
    if (sel) {
      const t = root.querySelector(sel);
      if (t) { try { t.focus({ preventScroll: true }); } catch { t.focus(); } }
    } else if (isTV() && mode !== 'link') {
      const t = root.querySelector('.pf-tile');
      if (t) { try { t.focus({ preventScroll: true }); } catch { t.focus(); } }
    }
  }

  // Back / Esc steps out of the link form and manage mode before it leaves the page.
  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !isBackKey(e)) return;
    if (mode === 'manage' && confirmId) { e.preventDefault(); e.stopPropagation(); confirmId = null; focusSel = '.pf-tile'; paint(); return; }
    if (mode === 'manage') { e.preventDefault(); e.stopPropagation(); mode = 'list'; focusSel = '.pf-manage'; paint(); return; }
    if (mode === 'link' && profiles().length) { e.preventDefault(); e.stopPropagation(); if (!busy) backToList(); }
  }
  document.addEventListener('keydown', onKey, true);

  paint();

  // Refresh the linked-profile list in the background (another device may have changed it).
  getMe().then(() => {
    if (!alive || busy) return;
    if (profileKey() === renderedKey) return;
    if (mode === 'list' || (mode === 'manage' && !confirmId)) {
      if (!profiles().length) { mode = 'link'; link = { prefill: '', relinkId: null, notice: '' }; }
      paint();
    }
  }).catch(() => {});

  return () => {
    stopPhone();
    alive = false;
    document.removeEventListener('keydown', onKey, true);
  };
}
