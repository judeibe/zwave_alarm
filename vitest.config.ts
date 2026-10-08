import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Auth is off by default in production; the existing suites cover the enforced path.
    env: { API_AUTH_REQUIRED: 'true' },
    // The app logs structured JSON on every request/transition; only show it for failing tests.
    silent: 'passed-only',
    // Many tests create a user and log in, which means real scrypt hashing (deliberately expensive).
    // On a busy machine that can exceed Vitest's 5 s default and fail a correct test.
    testTimeout: 20_000,
    // supertest starts a throwaway server per request on an OS-assigned port but connects to
    // 127.0.0.1:<port>. On a developer machine the OS can hand out a port that another process
    // (an editor helper, a dev server) already holds on 127.0.0.1, so now and then a request reaches
    // that stranger and fails with a 404/401/"socket hang up"/"Parse Error: Expected HTTP/" (about
    // one run in ten here). It is a collision, not an application bug, and a repeat is vanishingly
    // unlikely, so retry; a real failure still fails every attempt and is reported.
    retry: 2,
  },
});
