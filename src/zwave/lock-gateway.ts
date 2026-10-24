import type { Driver, ZWaveNode } from 'zwave-js';
import { NodeStatus, UserIDStatus } from 'zwave-js';
import { CommandClasses, ConfigValueFormat, isUnsupervisedOrSucceeded, type SupervisionResult } from '@zwave-js/core';
import { createLogger } from '../config/logger.js';
import { LockService, type LockPort, type ScheduleByKind, type ScheduleKind, type ScheduleSlotCounts, type UserCodeStatus, type UserSlot } from '../locks/lock-service.js';
import { SCHLAGE_PARAMETERS, identifySchlageLock } from '../locks/schlage.js';

const logger = createLogger('zwave/lock-gateway');

/** Battery level zwave-js reports when a device can only say "low", mapped to a number clients can show. */
const LOW_BATTERY_LEVEL = 10;

/**
 * The Z-Wave side of Schlage lock support, and the only lock code that touches zwave-js. It
 * recognises Schlage nodes by their manufacturer/product ids, mirrors their connectivity and
 * battery into the `LockService`, loads their parameters when they are ready, and carries out the
 * configuration, user code and Schedule Entry Lock commands the service asks for.
 */
export class ZwaveLockGateway implements LockPort {
  private readonly attachedNodeIds = new Set<number>();

  constructor(
    private readonly driver: Pick<Driver, 'controller'>,
    private readonly locks: LockService,
  ) {}

  /** Attaches to every known node plus any included later. Call on every "driver ready". */
  start(): void {
    this.attachedNodeIds.clear();
    this.driver.controller.nodes.forEach((node) => this.attachNode(node));
    this.driver.controller.on('node added', (node) => this.attachNode(node));
    logger.info('lock gateway started', { locks: this.locks.list().length });
  }

  async readParameter(nodeId: number, parameter: number): Promise<number | undefined> {
    const value = await this.node(nodeId).commandClasses.Configuration.get(parameter);
    if (typeof value !== 'number') {
      return undefined;
    }
    // A signed read of 0xFF is -1; the table says how wide the parameter is so it can be undone.
    const size = SCHLAGE_PARAMETERS.find((definition) => definition.parameter === parameter)?.size ?? 1;
    return value < 0 ? value + 2 ** (8 * size) : value;
  }

  async writeParameter(nodeId: number, parameter: number, size: 1 | 4, value: number): Promise<void> {
    const result = await this.node(nodeId).commandClasses.Configuration.set({
      parameter,
      value,
      valueSize: size,
      valueFormat: ConfigValueFormat.UnsignedInteger,
    });
    assertAccepted(result, `parameter ${String(parameter)}`);
  }

  async setUserCode(nodeId: number, userId: number, status: UserCodeStatus, code: string): Promise<void> {
    const result = await this.node(nodeId).commandClasses['User Code'].set(
      userId,
      status === 'enabled' ? UserIDStatus.Enabled : UserIDStatus.Disabled,
      code,
    );
    assertAccepted(result, `user code ${String(userId)}`);
  }

  async clearUserCode(nodeId: number, userId: number): Promise<void> {
    const result = await this.node(nodeId).commandClasses['User Code'].clear(userId);
    assertAccepted(result, `user code ${String(userId)}`);
  }

  async getUserSlot(nodeId: number, userId: number): Promise<UserSlot> {
    const report = await this.node(nodeId).commandClasses['User Code'].get(userId);
    if (!report) {
      throw new Error('the lock did not answer');
    }
    switch (report.userIdStatus) {
      case UserIDStatus.Enabled:
        return { userId, status: 'enabled' };
      case UserIDStatus.Disabled:
        return { userId, status: 'disabled' };
      default:
        return { userId, status: 'available' };
    }
  }

  async getScheduleSlotCounts(nodeId: number): Promise<ScheduleSlotCounts | undefined> {
    const supported = await this.node(nodeId).commandClasses['Schedule Entry Lock'].getNumSlots();
    return supported && { weekDay: supported.numWeekDaySlots, yearDay: supported.numYearDaySlots, dailyRepeating: supported.numDailyRepeatingSlots ?? 0 };
  }

  async setScheduleEnabled(nodeId: number, userId: number, enabled: boolean): Promise<void> {
    assertAccepted(await this.node(nodeId).commandClasses['Schedule Entry Lock'].setEnabled(enabled, userId), 'schedule state');
  }

  async setSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number, schedule: ScheduleByKind[K] | undefined): Promise<void> {
    const api = this.node(nodeId).commandClasses['Schedule Entry Lock'];
    const slot = { userId, slotId };
    let result: SupervisionResult | undefined;
    switch (kind) {
      case 'weekDay':
        result = await api.setWeekDaySchedule(slot, schedule as ScheduleByKind['weekDay'] | undefined);
        break;
      case 'yearDay':
        result = await api.setYearDaySchedule(slot, schedule as ScheduleByKind['yearDay'] | undefined);
        break;
      default:
        result = await api.setDailyRepeatingSchedule(slot, schedule as ScheduleByKind['dailyRepeating'] | undefined);
        break;
    }
    assertAccepted(result, `${kind} schedule`);
  }

  async getSchedule<K extends ScheduleKind>(nodeId: number, kind: K, userId: number, slotId: number): Promise<ScheduleByKind[K] | undefined> {
    const api = this.node(nodeId).commandClasses['Schedule Entry Lock'];
    const slot = { userId, slotId };
    const schedule =
      kind === 'weekDay' ? await api.getWeekDaySchedule(slot) : kind === 'yearDay' ? await api.getYearDaySchedule(slot) : await api.getDailyRepeatingSchedule(slot);
    return schedule as ScheduleByKind[K] | undefined;
  }

  private node(nodeId: number): ZWaveNode {
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`lock node ${String(nodeId)} not found on the Z-Wave network`);
    }
    return node;
  }

  private attachNode(node: ZWaveNode): void {
    if (this.attachedNodeIds.has(node.id)) {
      return;
    }
    this.attachedNodeIds.add(node.id);

    // Manufacturer/product ids are only known once the node's interview finishes.
    if (node.ready) {
      this.adopt(node);
    } else {
      node.once('ready', () => this.adopt(node));
    }
  }

  private adopt(node: ZWaveNode): void {
    const identity = identifySchlageLock({
      manufacturerId: node.manufacturerId ?? -1,
      productType: node.productType ?? -1,
      productId: node.productId ?? -1,
    });
    if (!identity) {
      return;
    }

    this.locks.add(node.id, identity, { connectivityStatus: node.status === NodeStatus.Dead ? 'offline' : 'online' });
    logger.info('lock recognised', { nodeId: node.id, model: identity.model });

    node.on('value updated', (n, args) => {
      if (args.commandClass === CommandClasses.Battery && args.property === 'level') {
        const raw = args.newValue as unknown;
        this.locks.updateStatus(n.id, { batteryLevel: typeof raw === 'number' ? raw : raw === 'low' ? LOW_BATTERY_LEVEL : null });
      } else if (args.commandClass === CommandClasses.Configuration && typeof args.property === 'number' && typeof args.newValue === 'number') {
        const size = SCHLAGE_PARAMETERS.find((definition) => definition.parameter === args.property)?.size ?? 1;
        this.locks.recordReport(n.id, args.property, args.newValue < 0 ? args.newValue + 2 ** (8 * size) : args.newValue);
      }
    });
    node.on('dead', (n) => this.locks.updateStatus(n.id, { connectivityStatus: 'offline' }));
    node.on('alive', (n) => this.locks.updateStatus(n.id, { connectivityStatus: 'online' }));

    // Load the lock's parameters in the background; clients can also ask for a refresh.
    void this.locks.refresh(node.id).catch((err: unknown) => {
      logger.warn('initial lock refresh failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    });
  }
}

function assertAccepted(result: SupervisionResult | undefined, what: string): void {
  if (!isUnsupervisedOrSucceeded(result)) {
    throw new Error(`the lock rejected ${what} (status ${String(result?.status)})`);
  }
}
