import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SERIAL_PORT', 'DB_PATH', 'HTTP_PORT', 'ZWAVE_SERVER_PORT', 'SESSION_SECRET'] as const;

function setEnv() {
  process.env.SERIAL_PORT = '/dev/ttyACM0';
  process.env.DB_PATH = ':memory:';
  process.env.HTTP_PORT = '3000';
  process.env.ZWAVE_SERVER_PORT = '3001';
  process.env.SESSION_SECRET = 'test-secret';
}

/**
 * ha-link-repository.ts imports `hashToken` from src/auth/token.ts, which
 * pulls in src/api/app.ts -> src/auth/session.ts -> src/config/index.ts and
 * validates required env vars *at import time* — a static top-level import
 * would run before beforeEach() sets them, so this dynamically imports after
 * env vars are in place, mirroring tests/unit/token.test.ts's precedent.
 */
async function setup() {
  const { createDatabase } = await import('../../src/db/schema.js');
  const { HaLinkRepository } = await import('../../src/db/repositories/ha-link-repository.js');
  const { UserRepository } = await import('../../src/auth/user-repository.js');
  const { hashToken } = await import('../../src/auth/token.js');

  const db = createDatabase(':memory:');
  const admin = new UserRepository(db).create({ name: 'Alice', role: 'administrator', code: '1111' });
  const repo = new HaLinkRepository(db);

  return { db, admin, repo, hashToken };
}

describe('HaLinkRepository', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env = { ...originalEnv };
  });

  it('creates a link with a disconnected default state and returns the plaintext token once', async () => {
    const { admin, repo, hashToken } = await setup();

    const { link, token } = repo.create('Living Room Hub', admin.id);

    expect(link.id).toBeTruthy();
    expect(link.label).toBe('Living Room Hub');
    expect(link.connectionStatus).toBe('disconnected');
    expect(link.lastSeenAt).toBeNull();
    expect(link.userId).toBe(admin.id);
    expect(token).toBeTruthy();
    expect(link.apiTokenHash).toBe(hashToken(token));
  });

  it('generates a distinct token (and hash) on each call', async () => {
    const { admin, repo } = await setup();

    const first = repo.create('Hub A', admin.id);
    const second = repo.create('Hub B', admin.id);

    expect(first.token).not.toBe(second.token);
    expect(first.link.apiTokenHash).not.toBe(second.link.apiTokenHash);
  });

  it('findByTokenHash resolves the link that issued a given token', async () => {
    const { repo, admin, hashToken } = await setup();
    const { link, token } = repo.create('Living Room Hub', admin.id);

    const found = repo.findByTokenHash(hashToken(token));

    expect(found?.id).toBe(link.id);
  });

  it('findByTokenHash returns undefined for an unknown hash', async () => {
    const { repo } = await setup();

    expect(repo.findByTokenHash('does-not-exist')).toBeUndefined();
  });

  it('list returns all links ordered by createdAt', async () => {
    const { repo, admin } = await setup();
    const first = repo.create('Hub A', admin.id);
    const second = repo.create('Hub B', admin.id);

    const result = repo.list();

    expect(result.map((l) => l.id)).toEqual([first.link.id, second.link.id]);
  });

  it('revoke deletes the link', async () => {
    const { repo, admin } = await setup();
    const { link } = repo.create('Living Room Hub', admin.id);

    repo.revoke(link.id);

    expect(repo.list()).toEqual([]);
  });

  it('rejects a link for an unknown user via the foreign key', async () => {
    const { repo } = await setup();

    expect(() => repo.create('Orphan Hub', 'missing-user')).toThrow(/FOREIGN KEY constraint failed/);
  });
});
