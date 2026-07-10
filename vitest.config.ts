import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const libsodiumCjs = require.resolve('libsodium-wrappers');

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: { alias: { 'libsodium-wrappers': libsodiumCjs } },
});
