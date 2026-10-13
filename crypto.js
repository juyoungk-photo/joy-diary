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
