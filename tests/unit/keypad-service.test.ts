import { describe, expect, it, vi } from 'vitest';
import { CommandClasses } from '@zwave-js/core';
import { KeypadNotFoundError, KeypadService, KeypadUnsupportedError } from '../../src/keypads/keypad-service.js';
import { ringKeypadV2Adapter } from '../../src/keypads/adapters/ring-keypad-v2.adapter.js';
import { acmePadAdapter } from './fixtures/keypad-adapters/acme-pad.adapter.js';

function build() {
  const writer = vi.fn().mockResolvedValue(undefined);
  const service = new KeypadService(writer);
  return { service, writer };
}

const entryControl = (eventType: number, eventData?: string) => ({
  commandClass: CommandClasses['Entry Control'],
  args: { eventType, eventData },
});

describe('KeypadService', () => {
  it('lists added keypads as summaries and announces new ones once', () => {
    const { service } = build();
    const changed = vi.fn();
    service.on('keypad_changed', changed);

    service.add(12, ringKeypadV2Adapter, { batteryLevel: 87 });
    service.add(12, ringKeypadV2Adapter);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(service.list()).toEqual([
      {
        nodeId: 12,
        adapterId: 'ring-keypad-v2',
        label: 'Ring Keypad v2',
        capabilities: ['arm_disarm', 'emergency', 'indicators', 'chime'],
        chimeSounds: ['double_beep', 'guitar', 'wind_chimes', 'bing_bong', 'doorbell'],
        connectivityStatus: 'online',
        batteryLevel: 87,
      },
    ]);
  });

  it('announces connectivity and battery changes, and nothing when nothing changed', () => {
    const { service } = build();
    service.add(12, ringKeypadV2Adapter);
    const changed = vi.fn();
    service.on('keypad_changed', changed);

    service.updateStatus(12, { connectivityStatus: 'offline' });
    service.updateStatus(12, { connectivityStatus: 'offline' });
    service.updateStatus(12, { batteryLevel: 55 });

    expect(changed).toHaveBeenCalledTimes(2);
    expect(service.list()[0]).toMatchObject({ connectivityStatus: 'offline', batteryLevel: 55 });
  });

  it('publishes decoded input to clients without the entered code, and with it to the controller', () => {
    const { service } = build();
    service.add(12, ringKeypadV2Adapter);
    const publicEvent = vi.fn();
    const internalEvent = vi.fn();
    service.on('keypad_event', publicEvent);
    service.on('keypad_input', internalEvent);

    service.receive(12, entryControl(2, '1234'));

    expect(publicEvent).toHaveBeenCalledWith({ nodeId: 12, adapterId: 'ring-keypad-v2', input: { kind: 'code_entered' } });
    expect(JSON.stringify(publicEvent.mock.calls)).not.toContain('1234');
    expect(internalEvent).toHaveBeenCalledWith({
      nodeId: 12,
      adapterId: 'ring-keypad-v2',
      input: { kind: 'code_entered', code: '1234' },
    });
  });

  it('ignores notifications that are not input, and ones from unknown nodes', () => {
    const { service } = build();
    service.add(12, ringKeypadV2Adapter);
    const publicEvent = vi.fn();
    service.on('keypad_event', publicEvent);

    service.receive(12, entryControl(0));
    service.receive(99, entryControl(5));

    expect(publicEvent).not.toHaveBeenCalled();
  });

  it('indicates on every keypad that supports indicators, using each one\'s own adapter', async () => {
    const { service, writer } = build();
    service.add(12, ringKeypadV2Adapter);
    service.add(13, acmePadAdapter);

    await service.indicateAll({ kind: 'mode', mode: 'armed_away' });

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(12, [
      { commandClass: CommandClasses.Indicator, endpoint: 0, property: 11, propertyKey: 1, value: 99 },
    ]);
  });

  it('skips an indication the adapter cannot render, and never throws when the write fails', async () => {
    const { service, writer } = build();
    service.add(13, acmePadAdapter);
    await service.indicate(13, { kind: 'alarm' });
    expect(writer).not.toHaveBeenCalled();

    service.add(12, ringKeypadV2Adapter);
    writer.mockRejectedValueOnce(new Error('node asleep'));
    await expect(service.indicate(12, { kind: 'alarm' })).resolves.toBeUndefined();
  });

  describe('chime', () => {
    it('writes the chime through the adapter', async () => {
      const { service, writer } = build();
      service.add(12, ringKeypadV2Adapter);

      await service.chime(12, 'doorbell', 70);

      expect(writer).toHaveBeenCalledWith(12, [
        { commandClass: CommandClasses.Indicator, endpoint: 0, property: 100, propertyKey: 9, value: 70 },
      ]);
    });

    it('rejects an unknown keypad, an unknown sound and a keypad without chime', async () => {
      const { service } = build();
      service.add(12, ringKeypadV2Adapter);
      service.add(13, acmePadAdapter);

      await expect(service.chime(99, 'doorbell')).rejects.toBeInstanceOf(KeypadNotFoundError);
      await expect(service.chime(12, 'kazoo')).rejects.toBeInstanceOf(KeypadUnsupportedError);
      await expect(service.chime(13, 'doorbell')).rejects.toBeInstanceOf(KeypadUnsupportedError);
    });
  });
});
