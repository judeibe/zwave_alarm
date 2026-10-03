import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';

describe('AlarmPanelRepository', () => {
  it('lazily creates the singleton row in its default disarmed state', () => {
    const repo = new AlarmPanelRepository(createDatabase(':memory:'));

    const panel = repo.getPanel();

    expect(panel.mode).toBe('disarmed');
    expect(panel.pendingDelayEndsAt).toBeNull();
    expect(panel.triggeredBy).toBeNull();
    expect(typeof panel.updatedAt).toBe('number');
  });

  it('returns the same row on repeated getPanel() calls rather than re-creating it', () => {
    const repo = new AlarmPanelRepository(createDatabase(':memory:'));

    const first = repo.getPanel();
    const second = repo.getPanel();

    expect(second).toEqual(first);
  });

  it('merges partial changes onto the current state and stamps updatedAt', () => {
    const repo = new AlarmPanelRepository(createDatabase(':memory:'));
    repo.getPanel();

    const updated = repo.updatePanel({ mode: 'arming', pendingDelayEndsAt: 1_000 });

    expect(updated.mode).toBe('arming');
    expect(updated.pendingDelayEndsAt).toBe(1_000);
    expect(updated.triggeredBy).toBeNull();

    const reread = repo.getPanel();
    expect(reread).toEqual(updated);
  });

  it('records triggeredBy and clears it back to null on a later update', () => {
    const db = createDatabase(':memory:');
    db.prepare(
      "INSERT INTO security_events (id, type, source, occurred_at) VALUES ('event-1', 'breach', 'system', 0)",
    ).run();
    const repo = new AlarmPanelRepository(db);

    const triggered = repo.updatePanel({ mode: 'alarm_triggered', triggeredBy: 'event-1' });
    expect(triggered.triggeredBy).toBe('event-1');

    const disarmed = repo.updatePanel({ mode: 'disarmed', triggeredBy: null, pendingDelayEndsAt: null });
    expect(disarmed.mode).toBe('disarmed');
    expect(disarmed.triggeredBy).toBeNull();
  });

  it('rejects a mode outside the documented enum at the database layer', () => {
    const repo = new AlarmPanelRepository(createDatabase(':memory:'));
    repo.getPanel();

    expect(() => repo.updatePanel({ mode: 'not-a-real-mode' as never })).toThrow(/CHECK constraint failed/);
  });
});
