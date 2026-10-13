// crypto.js — opens the catalog the builder sealed (tools/hubcrypto.py).
//
// PBKDF2-SHA256 → AES-256-GCM, envelope v1:
//   { v, kdf, iter, salt, iv, ct }   (base64; ct is ciphertext || tag)
// The iOS app will do the same with CryptoKit; change it only with a new v.

export const ENVELOPE_VERSION = 1;

/// What the family types, as the key sees it: NFC (Korean typed on iOS can
/// arrive decomposed), surrounding spaces dropped. hubcrypto.py does the same.
export function normalizeCode(code) {
  return String(code || '').normalize('NFC').trim();
}

function bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKey(code, envelope) {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey(
    'raw', new TextEncoder().encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(envelope.salt), iterations: envelope.iter },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

/// The catalog, or a thrown WrongCodeError when the code does not open it.
export async function openCatalog(envelope, code) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION) {
    throw new Error('Unknown catalog format ' + (envelope && envelope.v));
  }
  const key = await deriveKey(code, envelope);
  let plain;
  try {
    plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(envelope.iv) }, key, bytes(envelope.ct));
  } catch (e) {
    throw new WrongCodeError();
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

export class WrongCodeError extends Error {
  constructor() { super('wrong code'); this.name = 'WrongCodeError'; }
}

// MARK: - Album store (tools/hubcrypto.py → "Album store" says why)
//
//   master = PBKDF2-SHA256(code, store salt, iter)
//   key    = HKDF-SHA256(master, "joy-diary albums v1 encrypt")  AES-256-GCM
//   token  = b64url(HKDF-SHA256(master, "joy-diary albums v1 write"))
// An entry is { id, iv, ct }: {title, url} sealed with the id as associated data.

export const STORE_VERSION = 1;

function b64(buf) {
  const u = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}

/// { key, token } for the album store; one PBKDF2 run.
export async function storeKeys(code, saltB64, iterations) {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const material = await subtle.importKey(
    'raw', enc.encode(normalizeCode(code)), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(saltB64), iterations: iterations }, material, 256);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
  const key = await subtle.deriveKey(
    params('joy-diary albums v1 encrypt'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tokenBits = await subtle.deriveBits(params('joy-diary albums v1 write'), hkdf, 256);
  const token = b64(tokenBits).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { key: key, token: token };
}

export async function sealEntry(key, id, plain) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: enc.encode(id) }, key, enc.encode(JSON.stringify(plain)));
  return { id: id, iv: b64(iv), ct: b64(ct) };
}

/// The entry's {title, url}, or null when this key does not open it.
export async function openEntry(key, entry) {
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(entry.iv), additionalData: new TextEncoder().encode(entry.id) },
      key, bytes(entry.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return null;
  }
}
