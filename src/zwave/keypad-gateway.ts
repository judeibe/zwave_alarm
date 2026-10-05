import type { Driver, ZWaveNode } from 'zwave-js';
import { NodeStatus, setValueFailed } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { createLogger } from '../config/logger.js';
import type { KeypadAdapterRegistry } from '../keypads/keypad-registry.js';
import type { KeypadService } from '../keypads/keypad-service.js';
import type { ValueWrite } from '../keypads/keypad.js';

const logger = createLogger('zwave/keypad-gateway');

/** Battery level zwave-js reports when a device can only say "low", mapped to a number clients can show. */
const LOW_BATTERY_LEVEL = 10;

/**
 * The Z-Wave side of keypad support: the only keypad code that touches zwave-js. It recognises
 * keypad nodes through the adapter registry, forwards their notifications to the `KeypadService`,
 * mirrors their connectivity and battery, and carries out the value writes adapters ask for.
 */
export class KeypadGateway {
  private readonly attachedNodeIds = new Set<number>();

  constructor(
    private readonly driver: Pick<Driver, 'controller'>,
    private readonly registry: KeypadAdapterRegistry,
    private readonly keypads: KeypadService,
  ) {}

  /** Attaches to every known node plus any included later. Call once the driver is ready. */
  start(): void {
    this.driver.controller.nodes.forEach((node) => this.attachNode(node));
    this.driver.controller.on('node added', (node) => this.attachNode(node));
    logger.info('keypad gateway started', { keypads: this.keypads.list().length });
  }

  /** Writes to a keypad node, in order. Passed to `KeypadService` as its writer. */
  writeValues = async (nodeId: number, writes: ValueWrite[]): Promise<void> => {
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`keypad node ${String(nodeId)} not found on the Z-Wave network`);
    }
    for (const write of writes) {
      const result = await node.setValue(
        {
          commandClass: write.commandClass,
          endpoint: write.endpoint,
          property: write.property,
          ...(write.propertyKey !== undefined && { propertyKey: write.propertyKey }),
        },
        write.value,
      );
      if (setValueFailed(result)) {
        throw new Error(`keypad node ${String(nodeId)} rejected a write (status ${String(result.status)})`);
      }
    }
  };

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
    const adapter = this.registry.resolve({
      manufacturerId: node.manufacturerId ?? -1,
      productType: node.productType ?? -1,
      productId: node.productId ?? -1,
    });
    if (!adapter) {
      return;
    }

    this.keypads.add(node.id, adapter, { connectivityStatus: node.status === NodeStatus.Dead ? 'offline' : 'online' });
    logger.info('keypad recognised', { nodeId: node.id, adapterId: adapter.id });

    node.on('notification', (_endpoint, commandClass, args) => {
      this.keypads.receive(node.id, { commandClass, args: args as unknown as Record<string, unknown> });
    });
    node.on('value updated', (n, args) => {
      if (args.commandClass === CommandClasses.Battery && args.property === 'level') {
        const raw = args.newValue as unknown;
        this.keypads.updateStatus(n.id, { batteryLevel: typeof raw === 'number' ? raw : raw === 'low' ? LOW_BATTERY_LEVEL : null });
      }
    });
    node.on('dead', (n) => this.keypads.updateStatus(n.id, { connectivityStatus: 'offline' }));
    node.on('alive', (n) => this.keypads.updateStatus(n.id, { connectivityStatus: 'online' }));
  }
}
