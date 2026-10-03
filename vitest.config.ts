import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The app logs structured JSON on every request/transition; only show it for failing tests.
    silent: 'passed-only',
  },
});
