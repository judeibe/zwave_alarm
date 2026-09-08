import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';

describe('EventRepository', () => {
  afterEach(() => {
    vi.useRealTimers();
  });


  it('records an event with defaults for optional reference fields', () => {
    const repo = new EventRepository(createDatabase(':memory:'));

    const event = repo.record({ type: 'armed', source: 'user' });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe('armed');
    expect(event.source).toBe('user');
    expect(event.sourceUserId).toBeNull();
    expect(event.relatedZoneId).toBeNull();
    expect(event.relatedSensorId).toBeNull();
    expect(event.details).toBeNull();
    expect(typeof event.occurredAt).toBe('number');
  });

  it('records an event with all optional fields set', () => {
    const db = createDatabase(':memory:');
    const zone = new ZoneRepository(db).create('Front Door');
    const sensor = new SensorRepository(db).create({
      zwaveNodeId: 5,
      zoneId: zone.id,
      name: 'Door Sensor',
      category: 'intrusion',
    });
    const repo = new EventRepository(db);

    const event = repo.record({
      type: 'breach',
      source: 'system',
      relatedZoneId: zone.id,
      relatedSensorId: sensor.id,
      details: 'Sensor breached while armed_away',
    });

    expect(event.relatedZoneId).toBe(zone.id);
    expect(event.relatedSensorId).toBe(sensor.id);
    expect(event.details).toBe('Sensor breached while armed_away');
  });

  it('rejects an unknown event type via the CHECK constraint', () => {
    const repo = new EventRepository(createDatabase(':memory:'));

    expect(() =>
      repo.record({ type: 'not_a_real_type' as unknown as 'armed', source: 'user' }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('list returns events newest-first', () => {
    const repo = new EventRepository(createDatabase(':memory:'));
    const first = repo.record({ type: 'armed', source: 'user' });
    const second = repo.record({ type: 'disarmed', source: 'user' });
    const third = repo.record({ type: 'breach', source: 'system' });

    const result = repo.list();

    expect(result.map((e) => e.id)).toEqual([third.id, second.id, first.id]);
  });

  it('list filters to events at or after `since`', () => {
    const repo = new EventRepository(createDatabase(':memory:'));
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repo.record({ type: 'armed', source: 'user' });
    vi.setSystemTime(2_000);
    const after = repo.record({ type: 'disarmed', source: 'user' });

    const result = repo.list({ since: 2_000 });

    expect(result.map((e) => e.id)).toEqual([after.id]);
  });

  it('list caps results at `limit`', () => {
    const repo = new EventRepository(createDatabase(':memory:'));
    repo.record({ type: 'armed', source: 'user' });
    repo.record({ type: 'disarmed', source: 'user' });
    const last = repo.record({ type: 'breach', source: 'system' });

    const result = repo.list({ limit: 1 });

    expect(result.map((e) => e.id)).toEqual([last.id]);
  });
});
