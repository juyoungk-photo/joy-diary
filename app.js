// app.js — the family hub.
//
// Nothing public names the family: this file, the page and the manifest say
// "Joy Diary" (PUBLIC_TITLE). The real title arrives inside the encrypted
// catalog and replaces it once the code opens it.
//
// One page: a lock screen, then home (newest day, days by month,
// collections, photo albums), a list per day or collection, and a player
// that plays a list through. The catalog arrives encrypted (crypto.js) and
// is opened with the family code. Albums the family adds themselves come
// from a separate encrypted store (albums.js).
//
// Where the code lives: in localStorage, and in the address as #code=…
// iOS gives a home-screen web app its own storage, separate from Safari's,
// so the code has to ride along in the URL that 홈 화면에 추가 captures.
// The fragment is never sent to the server.

import { openCatalog, normalizeCode, WrongCodeError } from './crypto.js';
import { createAlbumStore, parseAlbumLink, cleanTitle, StoreError, TITLE_MAX } from './albums.js';

const CODE_KEY = 'familyhub.code';
const PUBLIC_TITLE = 'Joy Diary';
const app = document.getElementById('app');
let catalog = null;
let shownRoute = null;
let configPromise = null;
let albumStore = null;     // null when config.json names no store
let familyAlbums = null;   // decrypted store entries, newest first; null until known
let albumsEl = null;       // the home screen's 사진 앨범 section

// MARK: - Small helpers

function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) {}
}

const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  || window.navigator.standalone === true;
const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/// Phones and tablets: the only places where 홈 화면에 추가 means anything.
const isMobile = isApple || /Android/i.test(navigator.userAgent);

/// Element builder. Text is always text — titles come from YouTube.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'svg') el.innerHTML = v; // static markup only
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  return fill(el, ...kids);
}

/// Appends children the way h() does: arrays flattened, and null / false
/// (the `cond && node` idiom) skipped. The DOM's own append() would print
/// them as the words "null" and "false".
function fill(el, ...kids) {
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function mount(...nodes) {
  app.textContent = '';
  fill(app, ...nodes);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const year = y !== new Date().getFullYear() ? `${y}년 ` : '';
  return `${year}${m}월 ${d}일 (${wd})`;
}
function fmtMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${y}년 ${m}월`;
}
function fmtDuration(s) {
  s = s || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtTotal(ids) {
  const s = ids.reduce((sum, id) => sum + ((catalog.videos[id] || {}).duration || 0), 0);
  const m = Math.round(s / 60);
  return m < 1 ? '1분 미만' : `${m}분`;
}

function thumbURL(id, large) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${large ? 'hqdefault' : 'mqdefault'}.jpg`;
}
function thumb(id, badge, large) {
  return h('div', { class: 'thumb' },
    h('img', { src: thumbURL(id, large), alt: '', loading: 'lazy', decoding: 'async' }),
    badge);
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>';

// MARK: - Boot and lock

function inviteCode() {
  const m = /(?:^#|&)code=([^&]*)/.exec(location.hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

/// Keeps the code in the address, so adding to the home screen carries it.
function remember(code) {
  store(CODE_KEY, code);
  history.replaceState(history.state, '', location.pathname + location.search + '#code=' + encodeURIComponent(code));
}

async function fetchEnvelope() {
  const r = await fetch('data/catalog.enc.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('catalog ' + r.status);
  return r.json();
}

/// config.json, or null — nothing in it is needed to watch videos.
function fetchConfig() {
  return fetch('config.json', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  configPromise = fetchConfig();

  let envelope;
  try {
    envelope = await fetchEnvelope();
  } catch (e) {
    return renderOffline();
  }

  const tried = [];
  for (const code of [inviteCode(), stored(CODE_KEY)]) {
    if (!code || tried.indexOf(normalizeCode(code)) >= 0) continue;
    tried.push(normalizeCode(code));
    try {
      catalog = await openCatalog(envelope, code);
      remember(normalizeCode(code));
      return start(normalizeCode(code));
    } catch (e) {
      if (!(e instanceof WrongCodeError)) return renderOffline();
    }
  }
  if (tried.length) store(CODE_KEY, null);
  renderLock(envelope, tried.length > 0);
}

function renderLock(envelope, changed) {
  document.title = PUBLIC_TITLE;
  const input = h('input', {
    type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'none',
    autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go',
    placeholder: '가족 코드', 'aria-label': '가족 코드',
  });
  const error = h('p', { class: 'error', role: 'alert' });
  const button = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '열기');

  const unlocked = (code) => {
    window.removeEventListener('hashchange', onInvite);
    remember(code);
    start(code);
  };
  // An invite link opened while this screen is up changes only the
  // fragment, so the page does not start again by itself.
  const onInvite = async () => {
    const code = inviteCode();
    if (!code) return;
    try {
      catalog = await openCatalog(envelope, code);
      unlocked(normalizeCode(code));
    } catch (err) {
      error.textContent = '링크의 코드가 맞지 않아요. 코드를 직접 입력해 주세요.';
    }
  };
  window.addEventListener('hashchange', onInvite);

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const code = normalizeCode(input.value);
      if (!code) { input.focus(); return; }
      button.disabled = true;
      button.textContent = '여는 중…';
      error.textContent = '';
      try {
        catalog = await openCatalog(envelope, code);
        unlocked(code);
      } catch (err) {
        error.textContent = err instanceof WrongCodeError
          ? '코드가 맞지 않아요. 다시 확인해 주세요.'
          : '열지 못했어요. 잠시 후 다시 해 주세요.';
        button.disabled = false;
        button.textContent = '열기';
      }
    },
  }, input, button, error);

  mount(h('div', { class: 'lock' },
    h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
    h('h1', null, PUBLIC_TITLE),
    h('p', null, changed ? '가족 코드가 바뀌었어요. 새 코드를 입력해 주세요.' : '가족 코드를 입력해 주세요.'),
    form));
  input.focus();
}

function renderOffline() {
  mount(h('div', { class: 'lock' },
    h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
    h('h1', null, PUBLIC_TITLE),
    h('p', null, '인터넷 연결을 확인해 주세요.'),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, '다시 시도')));
}

async function start(code) {
  FocusPlayer.preload();
  window.addEventListener('popstate', onPopState);
  const config = await configPromise;
  albumStore = createAlbumStore(config && config.albumStore, code);
  route();
  loadFamilyAlbums();
}

// MARK: - Routing (?e=<event> | ?c=<collection>; the #code stays put)

function go(params) {
  const qs = new URLSearchParams(params).toString();
  history.pushState({ app: true }, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  route();
  window.scrollTo(0, 0);
}

function goBack() {
  if (history.state && history.state.app) history.back();
  else go({});
}

function onPopState() {
  if (player.open && !(history.state && history.state.player)) player.close();
  route();
}

function route() {
  const p = new URLSearchParams(location.search);
  const key = location.search;
  if (key === shownRoute) return; // e.g. the player closed over the same list
  shownRoute = key;

  const event = p.get('e') && catalog.events.find(e => e.id === p.get('e'));
  if (event) return renderList(event.title, fmtDate(event.date), event.videos, false);
  const col = p.get('c') && catalog.collections.find(c => c.id === p.get('c'));
  if (col) return renderList(col.title, null, col.videos, true);
  renderHome();
}

// MARK: - Home

function renderHome() {
  const c = catalog;
  document.title = c.title;
  const [latest, ...older] = c.events;
  const covers = collectionCovers(c.collections, latest ? [latest.videos[0]] : []);

  mount(h('div', { class: 'wrap' },
    h('header', { class: 'top' },
      h('div', null,
        h('h1', null, c.title),
        c.subtitle && h('p', { class: 'sub' }, c.subtitle)),
      h('button', { class: 'help-btn', type: 'button', onclick: openHelp }, '도움말')),

    latest && heroCard(latest),

    older.length > 0 && [h('h2', { class: 'section' }, '날짜별 영상'), eventRows(older)],

    c.collections.length > 0 && [
      h('h2', { class: 'section' }, '모아보기'),
      h('div', { class: 'tiles' }, c.collections.map((col, i) =>
        h('button', { class: 'tile', type: 'button', onclick: () => go({ c: col.id }) },
          thumb(covers[i]),
          h('div', { class: 'name' }, col.title),
          h('div', { class: 'info' }, `영상 ${col.videos.length}개`)))),
    ],

    albumSection(),

    footer()));
}

/// A different picture on each tile where the lists allow it — 2026, 교회
/// and 모든 영상 all start with the same newest clip.
function collectionCovers(collections, alreadyShown) {
  const used = new Set(alreadyShown);
  return collections.map(col => {
    const pick = col.videos.find(id => !used.has(id)) || col.videos[0];
    used.add(pick);
    return pick;
  });
}

function heroCard(event) {
  return h('button', {
    class: 'hero', type: 'button',
    onclick: () => player.play(event.videos, 0),
  },
    h('div', { class: 'thumb' },
      h('img', { src: thumbURL(event.videos[0], true), alt: '', decoding: 'async' }),
      h('div', { class: 'play' }, h('span', { svg: PLAY_SVG }))),
    h('div', { class: 'meta' },
      h('div', { class: 'label' }, '새로 올라온 영상 · ' + fmtDate(event.date)),
      h('div', { class: 'title' }, event.title),
      h('div', { class: 'info' }, `영상 ${event.videos.length}개 · ${fmtTotal(event.videos)} · 누르면 차례로 나와요`)));
}

function eventRows(events) {
  const out = [];
  let month = null;
  for (const e of events) {
    const m = fmtMonth(e.date);
    if (m !== month) { month = m; out.push(h('h3', { class: 'month' }, m)); }
    out.push(h('button', { class: 'row', type: 'button', onclick: () => go({ e: e.id }) },
      thumb(e.videos[0], h('span', { class: 'count' }, `${e.videos.length}개`)),
      h('div', { class: 'text' },
        h('div', { class: 'date' }, fmtDate(e.date)),
        h('div', { class: 'title' }, e.title))));
  }
  return h('div', { class: 'rows' }, out);
}

function footer() {
  const d = new Date(catalog.updatedAt);
  const updated = isNaN(d) ? '' : `${d.getMonth() + 1}월 ${d.getDate()}일 업데이트`;
  // On a computer, or already opened from the home screen, there is nothing to add.
  const showInstall = isMobile && !standalone;
  return h('p', { class: 'foot' },
    updated,
    showInstall && updated && ' · ',
    showInstall && h('a', { href: '#', onclick: (e) => { e.preventDefault(); openHelp(); } }, '홈 화면에 추가하는 방법'));
}

// MARK: - Photo albums
//
// The catalog's albums (tools/curation.json) first, then the ones the family
// added, newest first. A device can take out the albums it added. Without
// the store the section is the catalog's albums alone.

function albumSection() {
  albumsEl = h('section', { class: 'albums' });
  fillAlbums();
  return albumsEl;
}

function bakedAlbums() { return catalog.albums || []; }

function addedAlbums() {
  const known = bakedAlbums().map(a => a.url);
  return (familyAlbums || []).filter(a => known.indexOf(a.url) < 0);
}

function fillAlbums() {
  if (!albumsEl) return;
  const baked = bakedAlbums();
  const added = addedAlbums();
  albumsEl.textContent = '';
  albumsEl.hidden = !baked.length && !added.length && !albumStore;
  if (albumsEl.hidden) return;
  fill(albumsEl,
    h('h2', { class: 'section' }, '사진 앨범'),
    (baked.length > 0 || added.length > 0) && h('div', { class: 'rows' },
      baked.map(a => albumLink(a.title, a.note, a.url)),
      added.map(a => {
        const link = albumLink(a.title, addedNote(a), a.url);
        if (!a.mine) return link;
        return h('div', { class: 'album-row' }, link,
          h('button', { class: 'album-remove', type: 'button', 'aria-label': a.title + ' 빼기', onclick: () => confirmRemove(a) }, '빼기'));
      })),
    isApple && (baked.length > 0 || added.length > 0) &&
      h('button', { class: 'btn btn-soft btn-block photos-app', type: 'button', onclick: openPhotosApp }, '사진 앱에서 보기'),
    albumStore && h('button', { class: 'btn btn-soft btn-block add-album', type: 'button', onclick: openAddAlbum }, '+ 앨범 추가'));
}

/// For family invited to a shared album as subscribers: the Photos app is
/// faster than the web page and keeps the pictures. There is no link to one
/// album in Photos — `photos-redirect://` (undocumented, may stop working)
/// opens the app at its start — so the sheet says where to go from there.
function openPhotosApp() {
  const close = () => { document.removeEventListener('visibilitychange', left); sheet.remove(); };
  const status = h('p', { class: 'error', role: 'status' });
  let leftApp = false;
  const left = () => { if (document.hidden) leftApp = true; };

  const open = () => {
    leftApp = false;
    status.textContent = '';
    document.addEventListener('visibilitychange', left);
    window.location.href = 'photos-redirect://';
    setTimeout(() => {
      if (leftApp) { close(); return; }
      status.textContent = '사진 앱이 열리지 않았어요. 홈 화면에서 사진 앱을 직접 열어 주세요.';
    }, 1800);
  };

  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'panel', role: 'dialog', 'aria-label': '사진 앱에서 보기' },
      h('h2', null, '사진 앱에서 보기'),
      h('ol', null,
        h('li', null, '아래 버튼을 누르면 사진 앱이 열려요.'),
        h('li', null, "'공유 앨범'을 찾아 누르세요. 화면을 아래로 내리면 있어요."),
        h('li', null, '보고 싶은 앨범 이름을 누르세요.')),
      h('p', { class: 'note' }, '공유 앨범에 초대받은 경우에만 사진 앱에 보여요. 초대받지 않았다면 위의 앨범을 눌러 보세요.'),
      status,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: open }, '사진 앱 열기'),
        h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: close }, '닫기'))));
  document.body.append(sheet);
}

function albumLink(title, note, url) {
  return h('a', { class: 'album', href: url, target: '_blank', rel: 'noopener' },
    h('span', { class: 'icon', 'aria-hidden': 'true' }, '📷'),
    h('div', { class: 'text' },
      h('div', { class: 'name' }, title),
      note && h('div', { class: 'info' }, note)),
    h('span', { class: 'go' }, '열기 ›'));
}

function addedNote(a) {
  const d = new Date(a.createdAt);
  return isNaN(d) || !a.createdAt ? '가족이 추가한 앨범' : `${d.getMonth() + 1}월 ${d.getDate()}일에 추가`;
}

/// The last list this device saw, then the store's own; quietly keeps the
/// catalog's albums alone when neither comes.
async function loadFamilyAlbums() {
  if (!albumStore) return;
  albumStore.cached().then(list => {
    if (familyAlbums == null) { familyAlbums = list; fillAlbums(); }
  }).catch(() => {});
  try {
    familyAlbums = await albumStore.list();
    fillAlbums();
  } catch (e) {}
}

function storeMessage(err) {
  const kind = err instanceof StoreError ? err.kind : 'server';
  if (kind === 'offline') return '인터넷 연결을 확인하고 다시 눌러 주세요.';
  if (kind === 'unauthorized') return '지금은 바꿀 수 없어요. 가족 코드가 바뀌었는지 확인해 주세요.';
  if (kind === 'not-set-up') return '앨범 저장소가 아직 준비되지 않았어요.';
  if (kind === 'full') return '앨범이 너무 많아요. 안 보는 앨범을 먼저 빼 주세요.';
  return '저장하지 못했어요. 잠시 후 다시 해 주세요.';
}

function openAddAlbum() {
  const close = () => sheet.remove();
  const name = h('input', {
    type: 'text', id: 'album-name', maxlength: String(TITLE_MAX), autocomplete: 'off',
    enterkeyhint: 'next', placeholder: '예: 2026 가을 소풍',
  });
  const link = h('textarea', {
    id: 'album-link', rows: '3', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
    spellcheck: 'false', placeholder: '여기를 길게 눌러 붙여넣기',
  });
  const error = h('p', { class: 'error', role: 'alert' });
  const addBtn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '추가하기');

  const canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
  const paste = async () => {
    try {
      link.value = await navigator.clipboard.readText();
      error.textContent = '';
    } catch (e) {
      error.textContent = '붙여넣지 못했어요. 칸을 길게 눌러 붙여넣기를 눌러 주세요.';
    }
  };

  const fail = (message, field) => {
    error.textContent = message;
    if (field) field.focus();
  };

  const submit = async (e) => {
    e.preventDefault();
    const title = cleanTitle(name.value);
    if (!title) return fail('앨범 이름을 적어 주세요.', name);
    const parsed = parseAlbumLink(link.value);
    if (parsed.error === 'empty') return fail('링크를 붙여 넣어 주세요.', link);
    if (parsed.error === 'photoLink') return fail('이 링크는 사진 몇 장만 보내는 링크라 30일 뒤에 사라져요. 공유 앨범의 공개 웹사이트 링크를 넣어 주세요.', link);
    if (parsed.error) return fail('아이폰 공유 앨범 링크가 아니에요. 아래 방법으로 링크를 복사해 주세요.', link);
    const known = bakedAlbums().map(a => a.url).concat((familyAlbums || []).map(a => a.url));
    if (known.indexOf(parsed.url) >= 0) return fail('이미 목록에 있는 앨범이에요.', link);

    addBtn.disabled = true;
    addBtn.textContent = '저장하는 중…';
    error.textContent = '';
    try {
      await albumStore.add(title, parsed.url);
    } catch (err) {
      addBtn.disabled = false;
      addBtn.textContent = '추가하기';
      // The reply can be lost after the script saved it; the fresh list
      // lets the duplicate check catch a second try.
      loadFamilyAlbums();
      return fail(storeMessage(err));
    }
    close();
    loadFamilyAlbums();
  };

  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } },
    h('form', { class: 'panel', role: 'dialog', 'aria-label': '사진 앨범 추가', onsubmit: submit, novalidate: true },
      h('h2', null, '사진 앨범 추가'),
      h('p', { class: 'lead' }, "아이폰 공유 앨범의 '공개 웹사이트' 링크를 넣으면 가족 모두에게 보여요."),
      h('label', { class: 'field', for: 'album-name' }, '앨범 이름'),
      name,
      h('label', { class: 'field', for: 'album-link' }, '공유 앨범 링크'),
      link,
      canPaste && h('button', { class: 'btn btn-soft btn-block paste', type: 'button', onclick: paste }, '복사한 링크 붙여넣기'),
      error,
      h('div', { class: 'actions' },
        addBtn,
        h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: close }, '취소')),
      h('h3', null, '링크는 이렇게 복사해요'),
      h('ol', null,
        h('li', null, "아이폰 '사진' 앱 → 앨범 → 공유 앨범에서 앨범을 여세요."),
        h('li', null, '위쪽의 사람 모양 버튼을 누르세요.'),
        h('li', null, "'공개 웹사이트'를 켜고 '링크 공유' → '복사'를 누르세요."),
        h('li', null, "여기로 돌아와 '복사한 링크 붙여넣기'를 누르세요."))));
  document.body.append(sheet);
  name.focus();
}

function confirmRemove(album) {
  const close = () => sheet.remove();
  const error = h('p', { class: 'error', role: 'alert' });
  const removeBtn = h('button', {
    class: 'btn btn-primary btn-block', type: 'button',
    onclick: async () => {
      removeBtn.disabled = true;
      removeBtn.textContent = '빼는 중…';
      error.textContent = '';
      try {
        await albumStore.remove(album.id);
      } catch (err) {
        removeBtn.disabled = false;
        removeBtn.textContent = '목록에서 빼기';
        error.textContent = storeMessage(err);
        return;
      }
      familyAlbums = (familyAlbums || []).filter(a => a.id !== album.id);
      fillAlbums();
      close();
    },
  }, '목록에서 빼기');

  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'panel', role: 'dialog', 'aria-label': '앨범 빼기' },
      h('h2', null, `'${album.title}' 앨범을 목록에서 뺄까요?`),
      h('p', { class: 'lead' }, '아이폰에 있는 사진은 지워지지 않아요. 이 목록에서만 빠져요.'),
      error,
      h('div', { class: 'actions' },
        removeBtn,
        h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: close }, '취소'))));
  document.body.append(sheet);
}

// MARK: - A day or a collection

function renderList(title, subtitle, ids, showDates) {
  document.title = `${title} · ${catalog.title}`;
  mount(h('div', { class: 'wrap' },
    h('button', { class: 'back', type: 'button', onclick: goBack }, '‹ 처음으로'),
    h('div', { class: 'list-head' },
      h('h1', null, title),
      h('p', { class: 'info' }, [subtitle, `영상 ${ids.length}개`, fmtTotal(ids)].filter(Boolean).join(' · '))),
    h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => player.play(ids, 0) },
      '▶ 처음부터 모두 보기'),
    h('h2', { class: 'section' }, '하나씩 보기'),
    videoRows(ids, showDates, (i) => player.play(ids, i))));
}

function videoRows(ids, showDates, onPick, current) {
  return h('div', { class: 'rows' }, ids.map((id, i) => {
    const v = catalog.videos[id];
    return h('button', { class: 'row' + (i === current ? ' current' : ''), type: 'button', onclick: () => onPick(i) },
      thumb(id, h('span', { class: 'dur' }, fmtDuration(v.duration))),
      h('div', { class: 'text' },
        showDates && h('div', { class: 'date' }, fmtDate(v.date)),
        h('div', { class: 'title' }, v.title)));
  }));
}

// MARK: - Player
//
// One FocusPlayer for the whole visit. It is built inside the first tap, so
// that tap counts as permission to play; afterwards loadVideoById swaps
// videos on the same player and they keep playing with sound.

const player = (() => {
  const $ = (id) => document.getElementById(id);
  const el = $('player'), closeBtn = $('player-close'), pos = $('player-pos');
  const hint = $('player-hint'), cover = $('player-cover');
  const titleEl = $('player-title'), infoEl = $('player-info');
  const prevBtn = $('player-prev'), nextBtn = $('player-next'), queueEl = $('player-queue');

  let queue = [];
  let index = 0;
  let controller = null;
  let ready = false;
  let pendingId = null;
  let hintTimer = null;
  const state = { open: false };

  closeBtn.addEventListener('click', () => close(true));
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));

  function play(ids, i) {
    queue = ids.slice();
    index = i;
    if (!state.open) {
      state.open = true;
      el.hidden = false;
      document.body.style.overflow = 'hidden';
      history.pushState({ app: true, player: true }, '', location.href);
    }
    show();
  }

  function close(fromButton) {
    // The button walks history back, so the phone's own back gesture and
    // the button end the same way: popstate → close().
    if (fromButton && history.state && history.state.player) { history.back(); return; }
    if (!state.open) return;
    state.open = false;
    el.hidden = true;
    document.body.style.overflow = '';
    clearHint();
    if (controller) controller.pause();
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= queue.length) return;
    index = next;
    show();
  }

  function show() {
    const id = queue[index];
    const v = catalog.videos[id] || { title: '', date: '', duration: 0 };
    cover.hidden = true;
    titleEl.textContent = v.title;
    infoEl.textContent = [v.date && fmtDate(v.date), fmtDuration(v.duration)].filter(Boolean).join(' · ');
    pos.textContent = queue.length > 1 ? `${index + 1} / ${queue.length}` : '';
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index >= queue.length - 1;
    queueEl.textContent = '';
    if (queue.length > 1) {
      queueEl.append(videoRows(queue, false, (i) => { index = i; show(); }, index));
      const current = queueEl.querySelector('.current');
      if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    }
    if (v.embeddable === false) {
      if (controller) controller.stop();
      return showError(id, 'embedBlocked');
    }
    load(id);
  }

  function load(id) {
    armHint();
    if (!controller) {
      controller = FocusPlayer.create('yt', {
        videoId: id, autoplay: true, fit: 'host', endPolicy: 'stop', post: onEvent,
      });
      return;
    }
    if (ready && controller.load(id)) return;
    pendingId = id;
  }

  function onEvent(m) {
    if (m.event === 'ready') {
      ready = true;
      if (pendingId) { controller.load(pendingId); pendingId = null; }
      return;
    }
    if (!state.open) return;
    if (m.event === 'state') {
      if (m.state === FocusPlayer.STATE.PLAYING || m.state === FocusPlayer.STATE.BUFFERING) clearHint();
      // The player has already stopped (endPolicy 'stop'), so YouTube's
      // suggestion grid never shows; carry on or cover it.
      if (m.state === FocusPlayer.STATE.ENDED) ended();
    } else if (m.event === 'error') {
      showError(queue[index], m.kind);
    }
  }

  function ended() {
    if (index < queue.length - 1) { index++; show(); return; }
    clearHint();
    cover.textContent = '';
    cover.append(
      h('p', null, '다 봤어요 🙂'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { index = 0; show(); } }, '↺ 다시 보기'),
        h('button', { class: 'btn btn-soft', type: 'button', onclick: () => close(true) }, '목록으로')));
    cover.hidden = false;
  }

  function showError(id, kind) {
    clearHint();
    const message = kind === 'embedBlocked' ? '이 영상은 여기서 재생할 수 없어요.'
      : kind === 'removed' ? '이 영상은 지워졌거나 볼 수 없어요.'
      : '영상을 불러오지 못했어요.';
    cover.textContent = '';
    cover.append(
      h('p', null, message),
      h('div', { class: 'actions' },
        kind !== 'removed' && h('a', {
          class: 'btn btn-primary', target: '_blank', rel: 'noopener',
          href: 'https://www.youtube.com/watch?v=' + encodeURIComponent(id),
        }, 'YouTube에서 보기'),
        index < queue.length - 1 && h('button', { class: 'btn btn-soft', type: 'button', onclick: () => step(1) }, '다음 영상 ▶')));
    cover.hidden = false;
  }

  /// iOS may refuse to start sound without a tap inside the video itself.
  /// If nothing plays after a moment, say where to tap.
  function armHint() {
    clearHint();
    hintTimer = setTimeout(() => { if (state.open && cover.hidden) hint.hidden = false; }, 3500);
  }
  function clearHint() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hint.hidden = true;
  }

  return {
    play, close,
    get open() { return state.open; },
  };
})();

// MARK: - Help

function openHelp() {
  const guide = catalog.guide || {};
  const close = () => sheet.remove();
  const inviteURL = location.origin + location.pathname + location.hash;

  const install = standalone
    ? [h('p', null, '이미 홈 화면에 있어요 👍')]
    : isApple
      ? [h('ol', null,
          h('li', null, 'Safari 화면의 공유 버튼(네모에 위쪽 화살표)을 누르세요. 아이폰은 아래쪽, 아이패드는 위쪽에 있어요.'),
          h('li', null, "목록을 내려서 '홈 화면에 추가'를 누르세요."),
          h('li', null, "오른쪽 위 '추가'를 누르면 홈 화면에 아이콘이 생겨요."))]
      : isMobile
        ? [h('ol', null,
            h('li', null, '크롬 오른쪽 위 ⋮ 버튼을 누르세요.'),
            h('li', null, "'홈 화면에 추가' 또는 '앱 설치'를 누르세요."))]
        : [h('p', null, '휴대폰이나 아이패드에서 이 링크를 열면, 앱처럼 홈 화면에 아이콘을 둘 수 있어요. 아래 버튼으로 링크를 보내 보세요.')];

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: catalog.title, url: inviteURL });
      else { await navigator.clipboard.writeText(inviteURL); shareBtn.textContent = '링크를 복사했어요'; }
    } catch (e) {}
  };
  const shareBtn = h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: share }, '가족에게 이 링크 보내기');

  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'panel', role: 'dialog', 'aria-label': '도움말' },
      h('h2', null, '도움말'),
      guide.welcome && h('p', null, guide.welcome),
      (guide.help || []).length > 0 && h('ol', null, guide.help.map(t => h('li', null, t))),
      h('h2', null, '홈 화면에 추가하기'),
      install,
      h('h2', null, '사진 앨범'),
      h('ol', null,
        albumStore && h('li', null, "'+ 앨범 추가'로 아이폰 공유 앨범 링크를 넣으면 가족 모두가 볼 수 있어요."),
        h('li', null, "공유 앨범에 초대를 받았다면 아이폰 '사진' 앱 → 앨범 → '공유 앨범'에서도 볼 수 있어요. 앨범 주인이 허락하면 사진을 직접 올릴 수도 있어요.")),
      h('div', { class: 'actions' },
        shareBtn,
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: close }, '닫기'))));
  document.body.append(sheet);
}

boot();
