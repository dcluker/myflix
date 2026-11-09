// Netflix-style top bar. Built once by renderNav(); reacts to store events afterwards.
import * as store from './store.js';
import { el, icon, debounce, parseHash, avatarEl } from './util.js';
import { voiceSupported, listen } from './voice.js';
import { introSoundOn, setIntroSound } from './intro.js';

const LINKS = [
  ['home', 'Home', '#/'],
  ['shows', 'Shows', '#/shows'],
  ['movies', 'Movies', '#/movies'],
  ['new', 'New & Popular', '#/new'],
  ['mylist', 'My List', '#/mylist'],
  ['browse', 'Browse', '#/browse'],
  ['live', 'Live', '#/live'],
];

export function renderNav(headerEl) {
  if (!headerEl) return;
  headerEl.innerHTML = '';
  headerEl.classList.add('nav');

  // ---- left: wordmark, links ------------------------------------------------
  const logo = el('a', { class: 'nav-logo', href: '#/', 'aria-label': 'MyFlix home' }, 'MYFLIX');

  const linkEls = {};
  const links = el('ul', { class: 'nav-links', id: 'nav-links' },
    LINKS.map(([key, label, href]) => {
      const a = el('a', { href, 'data-nav': key }, label);
      linkEls[key] = a;
      return el('li', null, a);
    }));

  // Firefox-style tab pill (styled in base.css): glides to the hovered/focused link, rests on the
  // current page's link otherwise.
  const pill = el('li', { class: 'nav-pill', 'aria-hidden': 'true' });
  links.prepend(pill);
  const placePill = (a, hot, quiet) => {
    if (!a || !a.offsetWidth) { pill.classList.remove('is-on', 'is-hot', 'is-current', 'is-quiet'); return; }
    pill.classList.toggle('is-quiet', !!quiet);
    const lr = links.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    pill.style.transform = 'translate(' + (r.left - lr.left) + 'px,' + (r.top - lr.top) + 'px)';
    pill.style.width = r.width + 'px';
    pill.style.height = r.height + 'px';
    pill.classList.add('is-on');
    pill.classList.toggle('is-hot', !!hot);
    pill.classList.toggle('is-current', a.classList.contains('active'));
  };
  const restPill = () => {
    const f = document.activeElement;
    if (f && links.contains(f) && f.tagName === 'A') return placePill(f, true);
    // Focus on another header control (logo, search, profile): keep only the red underline on the
    // current page, so two things don't look selected at once.
    placePill(links.querySelector('a.active'), false, !!f && f !== document.body && headerEl.contains(f));
  };
  links.addEventListener('focusin', (e) => { const a = e.target.closest && e.target.closest('a'); if (a) placePill(a, true); });
  links.addEventListener('focusout', () => setTimeout(restPill, 0));
  links.addEventListener('mouseover', (e) => { const a = e.target.closest && e.target.closest('a'); if (a) placePill(a, true); });
  links.addEventListener('mouseleave', restPill);
  window.addEventListener('resize', restPill);
  try { document.fonts.ready.then(restPill); } catch {}

  const browseBtn = el('button', {
    class: 'nav-browse', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'nav-links',
  }, 'Browse ', el('span', { class: 'nav-caret', html: icon('caret', 18) }));

  // ---- right: search, profile ----------------------------------------------
  const input = el('input', {
    class: 'nav-search-input', type: 'search', placeholder: 'Titles, people, genres',
    'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search',
  });
  const searchBtn = el('button', { class: 'nav-search-btn', type: 'button', 'aria-label': 'Search', html: icon('search', 24) });
  const micBtn = voiceSupported() ? el('button', { class: 'nav-mic-btn', type: 'button', 'aria-label': 'Voice search', html: icon('mic', 20) }) : null;
  const searchBox = el('div', { class: 'nav-search' }, searchBtn, input, micBtn);

  const avatarSlot = el('span', { class: 'nav-avatar-slot' });
  const profileBtn = el('button', {
    class: 'nav-profile-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Account and profiles',
  }, avatarSlot, el('span', { class: 'nav-caret', html: icon('caret', 20) }), el('span', { class: 'nav-gear', html: icon('gear', 22) }));
  const menuBox = el('div', { class: 'nav-menu-box', role: 'menu' });
  const profileWrap = el('div', { class: 'nav-profile' }, profileBtn, el('div', { class: 'nav-menu' }, menuBox));

  headerEl.append(el('div', { class: 'nav-inner' }, logo, browseBtn, links, el('div', { class: 'nav-right' }, searchBox, profileWrap)));

  // ---- scroll state: transparent -> solid ------------------------------------
  const onScroll = () => headerEl.classList.toggle('solid', window.scrollY > 10);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- mobile "Browse" dropdown ----------------------------------------------
  const setBrowseOpen = (open) => {
    headerEl.classList.toggle('menu-open', open);
    browseBtn.setAttribute('aria-expanded', String(open));
  };
  browseBtn.addEventListener('click', (e) => { e.stopPropagation(); setBrowseOpen(!headerEl.classList.contains('menu-open')); closeProfile(); });
  links.addEventListener('click', (e) => { if (e.target.closest('a')) setBrowseOpen(false); });

  // ---- profile menu -----------------------------------------------------------
  function closeProfile() {
    profileWrap.classList.remove('open');
    profileBtn.setAttribute('aria-expanded', 'false');
  }
  function buildMenu() {
    menuBox.innerHTML = '';
    const me = store.get('me');
    const cur = store.get('profile');
    const others = ((me && me.profiles) || []).filter((p) => !cur || p.userId !== cur.userId);
    for (const p of others) {
      menuBox.append(el('button', {
        class: 'nav-menu-item', type: 'button', role: 'menuitem',
        onclick: () => {
          closeProfile();
          store.set('profile', { userId: p.userId, name: p.name, imageUrl: p.imageUrl || null });
        },
      }, avatarEl(p, 'sm'), el('span', null, p.display || p.name)));
    }
    if (others.length) menuBox.append(el('div', { class: 'nav-menu-sep' }));
    menuBox.append(
      el('a', { class: 'nav-menu-item', href: '#/profiles', role: 'menuitem', onclick: closeProfile }, 'Switch profile'),
      el('a', { class: 'nav-menu-item', href: '#/settings', role: 'menuitem', onclick: closeProfile }, 'Settings'),
      el('button', {
        class: 'nav-menu-item', type: 'button', role: 'menuitem',
        onclick: () => { closeProfile(); store.emit('library:refresh'); },
      }, 'Refresh library'),
      el('button', {
        class: 'nav-menu-item', type: 'button', role: 'menuitem',
        onclick: () => { setIntroSound(!introSoundOn()); closeProfile(); },
      }, 'Launch sound: ' + (introSoundOn() ? 'On' : 'Off')),
    );
  }
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !profileWrap.classList.contains('open');
    if (open) { buildMenu(); setBrowseOpen(false); }
    profileWrap.classList.toggle('open', open);
    profileBtn.setAttribute('aria-expanded', String(open));
  });
  // Hover-open (CSS) still needs a populated menu.
  profileWrap.addEventListener('mouseenter', buildMenu);
  document.addEventListener('click', (e) => {
    if (!profileWrap.contains(e.target)) closeProfile();
    if (!links.contains(e.target) && !browseBtn.contains(e.target)) setBrowseOpen(false);
  });

  function paintAvatar() {
    avatarSlot.innerHTML = '';
    const cur = store.get('profile');
    const full = cur && (((store.get('me') || {}).profiles) || []).find((p) => p.userId === cur.userId);   // has the picture / display name
    avatarSlot.append(avatarEl(full || cur, 'nav-avatar'));
  }
  paintAvatar();
  store.on('profile:updated', paintAvatar);
  store.on('profile:changed', paintAvatar);

  // ---- search -----------------------------------------------------------------
  let searchPushed = false; // true when we pushed the first #/search entry ourselves
  const isOpen = () => searchBox.classList.contains('open');

  function openSearch() {
    searchBox.classList.add('open');
    headerEl.classList.add('search-open');
    closeProfile();
    setBrowseOpen(false);
    input.focus();
  }
  function collapseSearch() {
    searchBox.classList.remove('open');
    headerEl.classList.remove('search-open');
  }
  function leaveSearchRoute() {
    if (parseHash().name !== 'search') return;
    if (searchPushed) { searchPushed = false; history.back(); }
    else location.replace('#/');
  }
  function go(q, immediate) {
    const v = q.trim();
    if (!v) { leaveSearchRoute(); return; }
    const target = '#/search?q=' + encodeURIComponent(v);
    if (location.hash === target) return;
    if (parseHash().name === 'search') location.replace(target);
    else { searchPushed = true; location.hash = target; }
  }
  const goDebounced = debounce(go, 250);

  searchBtn.addEventListener('click', () => {
    if (!isOpen()) openSearch();
    else if (input.value) input.focus();
    else collapseSearch();
  });
  input.addEventListener('input', () => goDebounced(input.value));
  if (micBtn) {
    micBtn.addEventListener('mousedown', (e) => e.preventDefault());   // keep the box open while the mic card shows
    micBtn.addEventListener('click', () => listen((q) => { openSearch(); input.value = q; go(q, true); }));
  }
  // On the TV the Fire TV keyboard's Next / Search key reaches us as Tab / Enter. Run the search, close
  // the keyboard (blur) and land on the first result, so Back isn't needed to dismiss it.
  const onTV = () => document.documentElement.classList.contains('tv');
  const focusFirstResult = (tries = 0) => {
    if (document.activeElement !== document.body) return;   // the user already moved
    const c = document.querySelector('#view [data-id]');
    if (c) { try { c.focus({ preventScroll: true }); } catch {} if (document.activeElement === c) return; }
    if (tries < 12) setTimeout(() => focusFirstResult(tries + 1), 250);
  };
  const commitSearch = () => {
    goDebounced.cancel();
    go(input.value, true);
    if (onTV() && input.value.trim()) { input.blur(); setTimeout(focusFirstResult, 300); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commitSearch(); }
    else if ((e.key === 'Tab' || e.keyCode === 9) && !e.shiftKey && onTV()) { e.preventDefault(); commitSearch(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      goDebounced.cancel();
      input.value = '';
      input.blur();
      collapseSearch();
      leaveSearchRoute();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (!input.value && document.activeElement !== input) collapseSearch(); }, 120);
  });

  // '/' focuses search (unless typing somewhere / nav is minimal).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (headerEl.classList.contains('nav-minimal')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    openSearch();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeProfile(); setBrowseOpen(false); }
  });

  // ---- route reactions ----------------------------------------------------------
  let lastActive = 'home';
  store.on('route', ({ name, params }) => {
    headerEl.classList.toggle('nav-minimal', name === 'profiles');
    closeProfile();
    setBrowseOpen(false);
    if (name !== 'title' && name !== 'search') lastActive = name;
    const active = name === 'search' ? null : lastActive;
    for (const [k, a] of Object.entries(linkEls)) {
      const on = k === active;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    requestAnimationFrame(restPill);
    if (name === 'search') {
      const q = (params && params.q) || '';
      if (document.activeElement !== input) input.value = q;
      searchBox.classList.add('open');
      headerEl.classList.add('search-open');
    } else if (name !== 'title') {
      searchPushed = false;
      if (document.activeElement !== input) { input.value = ''; collapseSearch(); }
    }
    onScroll();
  });
}
