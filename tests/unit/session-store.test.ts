import type { SessionData } from 'express-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpiringSessionStore } from '../../src/auth/session-store.js';

function sessionExpiringAt(expires: Date | undefined): SessionData {
  return { cookie: { originalMaxAge: 1000, expires } } as SessionData;
}

function get(store: ExpiringSessionStore, sid: string): Promise<SessionData | null | undefined> {
  return new Promise((resolve) => store.get(sid, (_err, data) => resolve(data)));
}

describe('ExpiringSessionStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a session until it expires', async () => {
    const store = new ExpiringSessionStore();
    const data = { ...sessionExpiringAt(new Date(Date.now() + 60_000)), userId: 'u1' } as SessionData;

    store.set('sid', data);

    expect(await get(store, 'sid')).toMatchObject({ userId: 'u1' });
  });

  it('returns nothing for an unknown sid', async () => {
    expect(await get(new ExpiringSessionStore(), 'nope')).toBeNull();
  });

  it('treats an expired session as absent and drops it', async () => {
    const store = new ExpiringSessionStore();
    store.set('sid', sessionExpiringAt(new Date(Date.now() - 1)));

    expect(await get(store, 'sid')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('treats a session with no expiry as already expired rather than immortal', async () => {
    const store = new ExpiringSessionStore();
    store.set('sid', sessionExpiringAt(undefined));

    expect(await get(store, 'sid')).toBeNull();
  });

  it('destroys a session', async () => {
    const store = new ExpiringSessionStore();
    store.set('sid', sessionExpiringAt(new Date(Date.now() + 60_000)));

    store.destroy('sid');

    expect(await get(store, 'sid')).toBeNull();
  });

  it('touch extends an existing session', async () => {
    const store = new ExpiringSessionStore();
    store.set('sid', sessionExpiringAt(new Date(Date.now() + 10)));

    store.touch('sid', sessionExpiringAt(new Date(Date.now() + 60_000)));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await get(store, 'sid')).not.toBeNull();
  });

  it('prunes abandoned sessions that are never looked up again', () => {
    vi.useFakeTimers();
    const store = new ExpiringSessionStore(1000);
    store.set('stale', sessionExpiringAt(new Date(Date.now() + 500)));
    store.set('fresh', sessionExpiringAt(new Date(Date.now() + 60_000)));

    vi.advanceTimersByTime(1000);

    expect(store.size).toBe(1);
  });
});
