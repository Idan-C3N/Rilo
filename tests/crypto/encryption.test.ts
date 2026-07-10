import { describe, it, expect, beforeAll } from 'vitest';
import { initCrypto, encrypt, decrypt } from '../../src/crypto/encryption.js';
import sodium from 'libsodium-wrappers';

beforeAll(async () => {
  await sodium.ready;
  const key = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  await initCrypto(key);
});

describe('encryption', () => {
  it('round-trips a secret', () => {
    const secret = 'sk-or-v1-abc123';
    const blob = encrypt(secret);
    expect(blob).not.toContain(secret);
    expect(decrypt(blob)).toBe(secret);
  });

  it('produces different ciphertext each time (random nonce)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });
});
