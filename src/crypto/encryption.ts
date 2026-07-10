import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

let key: Uint8Array | null = null;

export async function initCrypto(base64Key: string): Promise<void> {
  await sodium.ready;
  key = sodium.from_base64(base64Key, sodium.base64_variants.ORIGINAL);
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(`ENC_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes`);
  }
}

function requireKey(): Uint8Array {
  if (!key) throw new Error('crypto not initialized — call initCrypto first');
  return key;
}

export function encrypt(plain: string): string {
  const k = requireKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plain), nonce, k);
  const combined = new Uint8Array(nonce.length + cipher.length);
  combined.set(nonce);
  combined.set(cipher, nonce.length);
  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

export function decrypt(blob: string): string {
  const k = requireKey();
  const combined = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const cipher = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, k);
  return sodium.to_string(plain);
}
