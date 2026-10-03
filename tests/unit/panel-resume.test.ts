import type { Driver } from 'zwave-js';
import { SetValueStatus } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { Siren } from '../../src/alarm/siren.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';

/**
 * SC-006: the panel row survives a restart, but the setTimeout that finishes an exit delay or
 * escalates an entry delay does not. "Restart" below is a second PanelService built over the same
 * database after the first one's timer is discarded.
 */

const DELAY_MS = 30_000;

function buildDatabase() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zone = new ZoneRepository(db).create('Front Door');
  const sensor = new SensorRepository(db).create({
    zwaveNodeId: 2,
    zoneId: zone.id,
    name: 'Door',
    category: 'intrusion',
  });
  const newService = () =>
    new PanelService(panelRepo, eventRepo, { exitDelayMs: DELAY_MS, entryDelayMs: DELAY_MS });
  return { panelRepo, eventRepo, sensor, newService };
}

/** Starts a command on `service`, then discards it as a crash would: state persisted, timer gone. */
async function arm(service: PanelService, mode: 'armed_away' | 'armed_home') {
  const pending = service.arm(mode, { source: 'native' });
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  service.stop();
}

describe('PanelService.resume (SC-006)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('persisting the arming target', () => {
    it('records the target mode on arming and keeps it through the alarm states', async () => {
      const { panelRepo, sensor, newService } = buildDatabase();
      const service = newService();

      await arm(service, 'armed_home');
      expect(panelRepo.getPanel()).toMatchObject({ mode: 'arming', armedMode: 'armed_home' });

      service.resume();
      await vi.advanceTimersByTimeAsync(DELAY_MS);
      service.reportSensorBreach(sensor);
      expect(panelRepo.getPanel()).toMatchObject({ mode: 'alarm_pending', armedMode: 'armed_home' });
      service.stop();
    });

    it('clears it on disarm', async () => {
      const { panelRepo, newService } = buildDatabase();
      const service = newService();
      await arm(service, 'armed_away');

      const disarm = service.disarm({ source: 'native' });
      await vi.advanceTimersByTimeAsync(0);
      await disarm;

      expect(panelRepo.getPanel()).toMatchObject({ mode: 'disarmed', armedMode: null });
    });
  });

  describe('arming interrupted by a restart', () => {
    it.each(['armed_away', 'armed_home'] as const)('finishes arming into %s once the remaining delay elapses', async (mode) => {
      const { panelRepo, eventRepo, newService } = buildDatabase();
      await arm(newService(), mode);

      await vi.advanceTimersByTimeAsync(10_000); // downtime shorter than the exit delay
      const restarted = newService();
      restarted.resume();
      expect(panelRepo.getPanel().mode).toBe('arming');

      await vi.advanceTimersByTimeAsync(DELAY_MS - 10_000 - 1);
      expect(panelRepo.getPanel().mode).toBe('arming');
      await vi.advanceTimersByTimeAsync(1);

      expect(panelRepo.getPanel()).toMatchObject({ mode, pendingDelayEndsAt: null });
      expect(eventRepo.list()[0]).toMatchObject({ type: 'armed', source: 'system' });
    });

    it('finishes arming on the next tick when the exit delay elapsed during the downtime', async () => {
      const { panelRepo, newService } = buildDatabase();
      await arm(newService(), 'armed_away');

      await vi.advanceTimersByTimeAsync(DELAY_MS * 4);
      newService().resume();
      await vi.advanceTimersByTimeAsync(0);

      expect(panelRepo.getPanel().mode).toBe('armed_away');
    });

    it('lets a disarm during the resumed delay supersede it', async () => {
      const { panelRepo, newService } = buildDatabase();
      await arm(newService(), 'armed_away');
      const restarted = newService();
      restarted.resume();

      const disarm = restarted.disarm({ source: 'native' });
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
      await disarm;

      expect(panelRepo.getPanel().mode).toBe('disarmed');
    });

    it('falls back to disarmed when the row predates armed_mode and the target is unknowable', async () => {
      const { panelRepo, newService } = buildDatabase();
      panelRepo.updatePanel({ mode: 'arming', pendingDelayEndsAt: Date.now() + DELAY_MS, armedMode: null });
      const restarted = newService();

      restarted.resume();
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2);

      expect(panelRepo.getPanel().mode).toBe('disarmed');
    });
  });

  describe('entry delay interrupted by a restart', () => {
    async function persistPendingAlarm() {
      const harness = buildDatabase();
      const service = harness.newService();
      await arm(service, 'armed_away');
      service.resume();
      await vi.advanceTimersByTimeAsync(DELAY_MS);
      service.reportSensorBreach(harness.sensor);
      service.stop(); // crash with the entry delay still running
      expect(harness.panelRepo.getPanel().mode).toBe('alarm_pending');
      return harness;
    }

    it('escalates to alarm_triggered when the remaining entry delay elapses', async () => {
      const { panelRepo, eventRepo, sensor, newService } = await persistPendingAlarm();

      await vi.advanceTimersByTimeAsync(10_000);
      newService().resume();
      await vi.advanceTimersByTimeAsync(DELAY_MS - 10_000 - 1);
      expect(panelRepo.getPanel().mode).toBe('alarm_pending');
      await vi.advanceTimersByTimeAsync(1);

      expect(panelRepo.getPanel().mode).toBe('alarm_triggered');
      expect(eventRepo.list()[0]).toMatchObject({ type: 'alarm_triggered', relatedSensorId: sensor.id });
    });

    it('escalates immediately, with no fresh grace period, when the delay elapsed during the downtime', async () => {
      const { panelRepo, newService } = await persistPendingAlarm();

      await vi.advanceTimersByTimeAsync(DELAY_MS * 4);
      newService().resume();
      await vi.advanceTimersByTimeAsync(0);

      expect(panelRepo.getPanel().mode).toBe('alarm_triggered');
    });

    it('can still be disarmed during the resumed entry delay', async () => {
      const { panelRepo, newService } = await persistPendingAlarm();
      const restarted = newService();
      restarted.resume();

      const disarm = restarted.disarm({ source: 'native' });
      await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
      await disarm;

      expect(panelRepo.getPanel().mode).toBe('disarmed');
    });
  });

  it.each(['disarmed', 'armed_away', 'alarm_triggered'] as const)('leaves a persisted %s panel untouched', async (mode) => {
    const { panelRepo, newService } = buildDatabase();
    panelRepo.updatePanel({ mode, armedMode: mode === 'armed_away' ? 'armed_away' : null });
    const before = panelRepo.getPanel();

    newService().resume();
    await vi.advanceTimersByTimeAsync(DELAY_MS * 4);

    expect(panelRepo.getPanel()).toEqual(before);
  });

  it('is a no-op on a brand-new database', () => {
    const { panelRepo, newService } = buildDatabase();
    expect(() => newService().resume()).not.toThrow();
    expect(panelRepo.getPanel().mode).toBe('disarmed');
  });
});

describe('Siren after a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  class MockNode {
    setValue = vi.fn().mockResolvedValue({ status: SetValueStatus.Success });
  }

  /** A driver whose `controller` throws until `becomeReady()`, like zwave-js before "driver ready". */
  function buildHarness() {
    const { panelRepo, newService } = buildDatabase();
    const sirenNode = new MockNode();
    let ready = false;
    const driver = {
      get controller() {
        if (!ready) {
          throw new Error('The driver is not ready yet');
        }
        return { nodes: new Map([[5, sirenNode]]) };
      },
    };
    const panelService = newService();
    const siren = new Siren(driver as unknown as Driver, panelService, { nodeId: 5 });
    return { panelRepo, panelService, siren, sirenNode, becomeReady: () => (ready = true) };
  }

  it('sounds a siren for an alarm_triggered panel restored at boot, once the driver is ready', () => {
    const { panelRepo, siren, sirenNode, becomeReady } = buildHarness();
    panelRepo.updatePanel({ mode: 'alarm_triggered' });

    siren.sync(); // driver not ready yet: must neither throw nor send
    expect(sirenNode.setValue).not.toHaveBeenCalled();

    becomeReady();
    siren.sync();

    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
    expect(sirenNode.setValue).toHaveBeenCalledWith(
      { commandClass: CommandClasses['Binary Switch'], property: 'targetValue' },
      true,
    );
  });

  it('does not re-send on repeated syncs', () => {
    const { panelRepo, siren, sirenNode, becomeReady } = buildHarness();
    panelRepo.updatePanel({ mode: 'alarm_triggered' });
    becomeReady();

    siren.sync();
    siren.sync();

    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
  });

  it('survives an overdue entry delay escalating before the driver is ready, then sounds on sync', async () => {
    const { panelRepo, panelService, siren, sirenNode, becomeReady } = buildHarness();
    panelRepo.updatePanel({ mode: 'alarm_pending', armedMode: 'armed_away', pendingDelayEndsAt: Date.now() - 1 });

    panelService.resume();
    await vi.advanceTimersByTimeAsync(0); // fires the overdue entry delay with the driver still down
    expect(panelRepo.getPanel().mode).toBe('alarm_triggered');
    expect(sirenNode.setValue).not.toHaveBeenCalled();

    becomeReady();
    siren.sync();

    expect(sirenNode.setValue).toHaveBeenCalledTimes(1);
  });

  it('does nothing on sync for a disarmed panel', () => {
    const { siren, sirenNode, becomeReady } = buildHarness();
    becomeReady();

    siren.sync();

    expect(sirenNode.setValue).not.toHaveBeenCalled();
  });
});
