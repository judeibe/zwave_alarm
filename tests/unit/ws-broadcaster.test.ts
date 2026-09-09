import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Driver } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { SensorRepository } from '../../src/db/repositories/sensor-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import { SensorMapper } from '../../src/zwave/sensor-mapper.js';
import { createWebSocketServer } from '../../src/api/ws.js';
import { attachWsBroadcaster, buildLiveSnapshot } from '../../src/api/ws-broadcaster.js';

class MockNode {
  constructor(public readonly id: number) {}
  listeners: Record<string, (...args: never[]) => void> = {};
  on(event: string, handler: (...args: never[]) => void): void {
    this.listeners[event] = handler;
  }
  emit(event: string, ...args: unknown[]): void {
    this.listeners[event]?.(...(args as never[]));
  }
}

class MockNodeMap {
  private readonly byId = new Map<number, MockNode>();
  add(node: MockNode): void {
    this.byId.set(node.id, node);
  }
  forEach(callback: (node: MockNode) => void): void {
    this.byId.forEach(callback);
  }
}

class MockController {
  nodes = new MockNodeMap();
  on(): void {
    // No nodes are added after start() in these tests.
  }
}

class MockDriver {
  controller = new MockController();
}

/**
 * Collects every message a socket receives, resolving `nextMessage(i)` once
 * the i-th message has arrived — mirrors tests/unit/ws.test.ts's helper so
 * a message sent before a test starts `await`-ing isn't silently dropped.
 */
function collectMessages(ws: WebSocket): (index: number) => Promise<Record<string, unknown>> {
  const messages: string[] = [];
  const waiters: Array<() => void> = [];

  ws.on('message', (data) => {
    messages.push(data.toString());
    waiters.shift()?.();
  });

  return async (index: number): Promise<Record<string, unknown>> => {
    while (messages.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return JSON.parse(messages[index]!) as Record<string, unknown>;
  };
}

function buildHarness() {
  const db = createDatabase(':memory:');
  const panelRepo = new AlarmPanelRepository(db);
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const sensorRepo = new SensorRepository(db);
  const panelService = new PanelService(panelRepo, eventRepo, { exitDelayMs: 1, entryDelayMs: 100_000 });

  const zone = zoneRepo.create('Front Door');
  const intrusionSensor = sensorRepo.create({
    zwaveNodeId: 10,
    zoneId: zone.id,
    name: 'Door contact',
    category: 'intrusion',
  });

  const driver = new MockDriver();
  const node = new MockNode(10);
  driver.controller.nodes.add(node);
  const sensorMapper = new SensorMapper(driver as unknown as Driver, sensorRepo, panelService, eventRepo);
  sensorMapper.start();

  return { panelService, sensorMapper, eventRepo, zoneRepo, sensorRepo, zone, intrusionSensor, node };
}

describe('ws-broadcaster', () => {
  let wss: WebSocketServer | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = undefined;
    client = undefined;
  });

  async function connect(harness: ReturnType<typeof buildHarness>) {
    wss = createWebSocketServer({ port: 0 }, () =>
      buildLiveSnapshot({ panelService: harness.panelService, zoneRepo: harness.zoneRepo }),
    );
    attachWsBroadcaster(wss, harness);
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    const nextMessage = collectMessages(client);
    await once(client, 'open');
    return nextMessage;
  }

  it('sends a live snapshot (real panel mode and joined zones/sensors) on connect', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);

    const snapshot = await nextMessage(0);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.panel).toEqual({ mode: 'disarmed', pendingDelayEndsAt: null });
    expect((snapshot.zones as unknown[]).length).toBe(1);
  });

  it('broadcasts panel.changed with a resolved triggeredBy when an armed intrusion sensor breaches', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0); // discard snapshot

    await harness.panelService.arm('armed_away', { source: 'native' });
    // arm()'s promise resolves as soon as the 'arming' transition commits, not once the
    // 1ms exit-delay timer completes armed_away — wait for the panel to actually settle.
    while (harness.panelService.getState().mode !== 'armed_away') {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(await nextMessage(1)).toMatchObject({ type: 'panel.changed', mode: 'arming' });
    expect(await nextMessage(2)).toMatchObject({ type: 'panel.changed', mode: 'armed_away', triggeredBy: null });
    expect((await nextMessage(3)).type).toBe('event.recorded'); // the 'armed' SecurityEvent

    harness.node.emit('notification', {}, CommandClasses.Notification, {
      type: 6,
      label: 'Access Control',
      event: 22,
      eventLabel: 'Door/window open',
    });

    // The sensor's own currentState transition broadcasts as sensor.changed, then the
    // resulting 'breach' SecurityEvent, then the panel's alarm_pending transition.
    expect((await nextMessage(4)).type).toBe('sensor.changed');
    expect((await nextMessage(5)).type).toBe('event.recorded');

    const breached = await nextMessage(6);
    expect(breached).toMatchObject({ type: 'panel.changed', mode: 'alarm_pending' });
    expect(breached.triggeredBy).toEqual({ sensorId: harness.intrusionSensor.id, zoneId: harness.zone.id });
  });

  it('broadcasts sensor.changed on a breach edge', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0);

    harness.node.emit('value updated', { id: 10 }, {
      commandClass: CommandClasses['Binary Sensor'],
      commandClassName: 'Binary Sensor',
      property: 'Any',
      newValue: true,
      prevValue: false,
    });

    const message = await nextMessage(1);
    expect(message).toEqual({
      type: 'sensor.changed',
      sensorId: harness.intrusionSensor.id,
      zoneId: harness.zone.id,
      currentState: 'breached',
      category: 'intrusion',
    });
  });

  it('broadcasts sensor.fault on a connectivity change, including recovery', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0);

    harness.node.emit('dead', harness.node, 'Awake');
    const fault = await nextMessage(1);
    expect(fault).toEqual({
      type: 'sensor.fault',
      sensorId: harness.intrusionSensor.id,
      connectivityStatus: 'offline',
      batteryLevel: null,
    });
    expect((await nextMessage(2)).type).toBe('event.recorded'); // the 'device_fault' SecurityEvent

    harness.node.emit('alive', harness.node, 'Dead');
    const recovered = await nextMessage(3);
    expect(recovered).toMatchObject({ type: 'sensor.fault', connectivityStatus: 'online' });
  });

  it('broadcasts event.recorded whenever the EventRepository records a new SecurityEvent', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0);

    const event = harness.eventRepo.record({ type: 'lockout', source: 'system' });

    const message = await nextMessage(1);
    expect(message).toEqual({
      type: 'event.recorded',
      event: { id: event.id, type: 'lockout', occurredAt: event.occurredAt },
    });
  });

  it('broadcasts to every connected client', async () => {
    const harness = buildHarness();
    const firstNextMessage = await connect(harness);
    await firstNextMessage(0);

    const { port } = (wss as WebSocketServer).address() as AddressInfo;
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const secondNextMessage = collectMessages(second);
    await once(second, 'open');
    await secondNextMessage(0);

    harness.eventRepo.record({ type: 'lockout', source: 'system' });

    expect((await firstNextMessage(1)).type).toBe('event.recorded');
    expect((await secondNextMessage(1)).type).toBe('event.recorded');

    second.close();
  });
});
