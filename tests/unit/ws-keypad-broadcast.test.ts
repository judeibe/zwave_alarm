import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CommandClasses } from '@zwave-js/core';
import { createDatabase } from '../../src/db/schema.js';
import { AlarmPanelRepository } from '../../src/alarm/panel-repository.js';
import { EventRepository } from '../../src/events/event-repository.js';
import { ZoneRepository } from '../../src/db/repositories/zone-repository.js';
import { PanelService } from '../../src/alarm/panel-service.js';
import type { SensorMapper } from '../../src/zwave/sensor-mapper.js';
import { KeypadService } from '../../src/keypads/keypad-service.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';
import { createWebSocketServer } from '../../src/api/ws.js';
import { attachWsBroadcaster, buildLiveSnapshot } from '../../src/api/ws-broadcaster.js';

function collectMessages(ws: WebSocket): (index: number) => Promise<Record<string, unknown>> {
  const messages: string[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (data) => {
    messages.push(data.toString());
    waiters.shift()?.();
  });
  return async (index) => {
    while (messages.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return JSON.parse(messages[index]!) as Record<string, unknown>;
  };
}

function buildHarness() {
  const db = createDatabase(':memory:');
  const eventRepo = new EventRepository(db);
  const zoneRepo = new ZoneRepository(db);
  const panelService = new PanelService(new AlarmPanelRepository(db), eventRepo);
  const keypadService = new KeypadService(vi.fn().mockResolvedValue(undefined));
  keypadService.add(12, ringKeypadV2Adapter);
  // The broadcaster only subscribes to the mapper's events, which keypads never emit.
  const sensorMapper = new EventEmitter() as unknown as SensorMapper;
  return { panelService, keypadService, eventRepo, zoneRepo, sensorMapper };
}

describe('keypad websocket events', () => {
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
      buildLiveSnapshot({ panelService: harness.panelService, zoneRepo: harness.zoneRepo, keypadService: harness.keypadService }),
    );
    attachWsBroadcaster(wss, harness);
    await once(wss, 'listening');
    client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    const nextMessage = collectMessages(client);
    await once(client, 'open');
    return nextMessage;
  }

  it('includes the keypads in the snapshot', async () => {
    const nextMessage = await connect(buildHarness());

    const snapshot = await nextMessage(0);
    expect(snapshot.keypads).toEqual([expect.objectContaining({ nodeId: 12, adapterId: 'ring-keypad-v2', connectivityStatus: 'online' })]);
  });

  it('pushes keypad.changed when a keypad goes offline', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0);

    harness.keypadService.updateStatus(12, { connectivityStatus: 'offline' });

    expect(await nextMessage(1)).toMatchObject({
      type: 'keypad.changed',
      keypad: { nodeId: 12, connectivityStatus: 'offline' },
    });
  });

  it('pushes keypad.event for a button press and never includes the entered code', async () => {
    const harness = buildHarness();
    const nextMessage = await connect(harness);
    await nextMessage(0);

    harness.keypadService.receive(12, {
      commandClass: CommandClasses['Entry Control'],
      args: { eventType: 2, eventData: '1234' },
    });

    const message = await nextMessage(1);
    expect(message).toEqual({ type: 'keypad.event', nodeId: 12, adapterId: 'ring-keypad-v2', input: { kind: 'code_entered' } });
    expect(JSON.stringify(message)).not.toContain('1234');
  });

  it('leaves the snapshot without keypads when no keypad service is wired', async () => {
    const harness = buildHarness();
    wss = createWebSocketServer({ port: 0 }, () => buildLiveSnapshot({ panelService: harness.panelService, zoneRepo: harness.zoneRepo }));
    attachWsBroadcaster(wss, harness);
    await once(wss, 'listening');
    client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    const nextMessage = collectMessages(client);
    await once(client, 'open');

    expect(await nextMessage(0)).not.toHaveProperty('keypads');
  });
});
