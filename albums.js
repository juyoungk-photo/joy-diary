// albums.js — photo albums the family adds from inside the hub.
//
// They live in a Google Apps Script web app (apps-script/Code.gs in the
// private repository) whose address is in config.json. The script sees only
// ciphertext: each album is sealed here with a key from the family code
// (crypto.js → storeKeys), and writes carry a token from the same code.
//
// Everything here fails soft. If the script cannot be reached the hub shows
// the albums baked into the catalog plus the last list it saw.

import { storeKeys, sealEntry, openEntry } from './crypto.js';

const CACHE_KEY = 'familyhub.albums';     // last list from the script (ciphertext)
const MINE_KEY = 'familyhub.myAlbums';    // ids this device added
const LIST_TIMEOUT = 12000;
const WRITE_TIMEOUT = 20000;              // Apps Script can take a few seconds to wake

export const TITLE_MAX = 40;

// MARK: - Links

// The public-website link of an iCloud shared album, optionally with a
// locale ("ko-kr/") and a photo (";guid"). The pattern is written escaped
// on purpose: publish.sh keeps plain album links out of public files.
const SHARED_ALBUM_RE = /https?:\/\/(?:www\.)?icloud\.com\/sharedalbum\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2,4})?\/)?#[A-Za-z0-9]{6,}(?:;[A-Za-z0-9-]+)?/i;
const ICLOUD_PHOTO_LINK_RE = /icloud\.com\/(?:photos|iclouddrive)\//i;

/// { url } for a shared-album link found anywhere in the pasted text, else
/// { error: 'empty' | 'photoLink' | 'notAlbum' }.
export function parseAlbumLink(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'empty' };
  const m = SHARED_ALBUM_RE.exec(s);
  if (m) {
    const url = m[0].replace(/^http:/i, 'https:').replace(/^https:\/\/icloud\./i, 'https://www.icloud.');
    return { url: url };
  }
  if (ICLOUD_PHOTO_LINK_RE.test(s)) return { error: 'photoLink' };
  return { error: 'notAlbum' };
}

/// The name as stored: spaces collapsed, at most TITLE_MAX characters.
export function cleanTitle(text) {
  return Array.from(String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX).join('');
}

export function newId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let s = 'e';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// MARK: - The store

export class StoreError extends Error {
  /// kind: 'offline' | 'unauthorized' | 'not-set-up' | 'full' | 'server'
  constructor(kind) { super('album store: ' + kind); this.name = 'StoreError'; this.kind = kind; }
}

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreError('offline')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); });
  });
}

/// config: { url, salt, iter } from config.json; code: the family code.
/// Returns null when no store is configured.
export function createAlbumStore(config, code) {
  if (!config || !config.url || !config.salt || !config.iter) return null;
  let keysPromise = null;

  function keys() {
    if (!keysPromise) {
      keysPromise = storeKeys(code, config.salt, config.iter);
      keysPromise.catch(() => { keysPromise = null; });
    }
    return keysPromise;
  }

  async function request(init, ms) {
    let r;
    try {
      r = await withTimeout(fetch(config.url, init), ms);
    } catch (e) {
      throw e instanceof StoreError ? e : new StoreError('offline');
    }
    let body;
    try { body = await r.json(); } catch (e) { throw new StoreError('server'); }
    if (!body || !body.ok) {
      const kind = body && body.error;
      throw new StoreError(kind === 'unauthorized' || kind === 'not-set-up' || kind === 'full' ? kind : 'server');
    }
    return body;
  }

  // text/plain keeps this a "simple" request: Apps Script cannot answer a
  // CORS preflight.
  function post(body) {
    return request({
      method: 'POST', body: JSON.stringify(body), redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    }, WRITE_TIMEOUT);
  }

  async function decrypt(entries) {
    const k = (await keys()).key;
    const mine = readJSON(MINE_KEY, []);
    const out = [];
    for (const e of entries) {
      const plain = await openEntry(k, e);
      const link = plain && parseAlbumLink(plain.url);
      if (!link || !link.url) continue; // another code's entry, or junk
      out.push({ id: e.id, title: cleanTitle(plain.title) || '사진 앨범', url: link.url,
        createdAt: e.createdAt || 0, mine: mine.indexOf(e.id) >= 0 });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  function cachedEntries() { return readJSON(CACHE_KEY, []); }

  return {
    /// The last list this device saw, decrypted.
    cached() { return decrypt(cachedEntries()); },

    /// The script's list, decrypted; remembered for next time.
    async list() {
      const body = await request({ method: 'GET', cache: 'no-store' }, LIST_TIMEOUT);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      writeJSON(CACHE_KEY, entries);
      return decrypt(entries);
    },

    async add(title, url) {
      const k = await keys();
      const sealed = await sealEntry(k.key, newId(), { title: title, url: url });
      const body = await post({ action: 'add', token: k.token, id: sealed.id, iv: sealed.iv, ct: sealed.ct });
      const mine = readJSON(MINE_KEY, []);
      mine.push(sealed.id);
      writeJSON(MINE_KEY, mine);
      writeJSON(CACHE_KEY, cachedEntries().concat([body.entry || sealed]));
    },

    async remove(id) {
      const k = await keys();
      await post({ action: 'delete', token: k.token, id: id });
      writeJSON(CACHE_KEY, cachedEntries().filter(e => e.id !== id));
      writeJSON(MINE_KEY, readJSON(MINE_KEY, []).filter(x => x !== id));
    },

    /// Starts the slow key derivation early, while the home screen draws.
    warm() { keys().catch(() => {}); },
  };
}
