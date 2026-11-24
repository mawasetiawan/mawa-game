const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Format kode login tidak valid');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function randomCode() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

async function aesKey(code, usage) {
  return crypto.subtle.importKey('raw', decode(code), 'AES-GCM', false, [usage]);
}

export async function seal(code, session, credential) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(code, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(session) },
    key,
    encoder.encode(JSON.stringify(credential)),
  );
  return encode([...iv, ...new Uint8Array(ciphertext)]);
}

export async function unseal(code, session, payload) {
  const bytes = decode(payload);
  const key = await aesKey(code, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(session) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(decoder.decode(plaintext));
}
