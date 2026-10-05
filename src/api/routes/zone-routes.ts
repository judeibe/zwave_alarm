import { Router } from 'express';
import { NodeStatus, type Driver } from 'zwave-js';
import { ApiError } from '../app.js';
import {
  assignSensorBodySchema,
  createZoneBodySchema,
  deleteZoneQuerySchema,
  parsedQuery,
  updateSensorBodySchema,
  updateZoneBodySchema,
  validateBody,
  validateQuery,
} from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { UserRepository } from '../../auth/user-repository.js';
import type { ZoneRepository } from '../../db/repositories/zone-repository.js';
import type { SensorCategory, SensorRepository } from '../../db/repositories/sensor-repository.js';

export interface ZoneRouteDeps {
  zoneRepo: ZoneRepository;
  sensorRepo: SensorRepository;
  userRepo: UserRepository;
  /** Only `controller.nodes` is read (to validate a zwaveNodeId is known before assigning it). */
  driver: Pick<Driver, 'controller'>;
}

interface DiscoverableNode {
  zwaveNodeId: number;
  name: string | null;
  manufacturer: string | null;
  product: string | null;
  suggestedCategory: SensorCategory | null;
  status: 'alive' | 'dead' | 'asleep';
}

interface AssignSensorBody {
  zwaveNodeId: number;
  name: string;
  category: SensorCategory;
}

/**
 * `GET /api/v1/zones`, `POST /api/v1/zones`, `POST /api/v1/zones/{zoneId}/sensors`
 * (contracts/rest-api.md's "Zones & Sensors" section), wired to T018's
 * ZoneRepository and T019's SensorRepository.
 *
 * Assigning a sensor validates `zwaveNodeId` against the live `zwave-js`
 * driver (data-model.md's SensorDevice validation rule) — the check T019's
 * completion note deferred because `SensorRepository.create` has no driver
 * handle; this route does. A `zoneId` that doesn't exist, or a
 * `zwaveNodeId` already assigned elsewhere, surface as SensorRepository/DB
 * errors (FK violation / duplicate-node rejection respectively) and are
 * mapped to 404/409 here rather than a generic 500.
 */
export function createZoneRouter({ zoneRepo, sensorRepo, userRepo, driver }: ZoneRouteDeps): Router {
  const router = Router();

  router.get('/zones', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json(zoneRepo.list());
  });

  router.post('/zones', requireAuth, requireRole('administrator'), validateBody(createZoneBodySchema), (req, res) => {
    const { name, description } = req.body as { name: string; description?: string | null };
    if (zoneRepo.findByName(name)) {
      throw new ApiError(409, 'conflict', `A zone named "${name}" already exists.`);
    }
    res.status(201).json(zoneRepo.create(name, description ?? null));
  });

  router.patch(
    '/zones/:zoneId',
    requireAuth,
    requireRole('administrator'),
    validateBody(updateZoneBodySchema),
    (req, res) => {
      const changes = req.body as { name?: string; description?: string | null };
      if (!zoneRepo.findById(req.params.zoneId)) {
        throw new ApiError(404, 'not_found', `Zone ${req.params.zoneId} does not exist.`);
      }
      const clash = changes.name === undefined ? undefined : zoneRepo.findByName(changes.name);
      if (clash && clash.id !== req.params.zoneId) {
        throw new ApiError(409, 'conflict', `A zone named "${changes.name}" already exists.`);
      }
      res.status(200).json(zoneRepo.update(req.params.zoneId, changes));
    },
  );

  router.delete(
    '/zones/:zoneId',
    requireAuth,
    requireRole('administrator'),
    validateQuery(deleteZoneQuerySchema),
    (req, res) => {
      const { force } = parsedQuery<{ force?: 'true' | 'false' }>(res);
      const zone = zoneRepo.findById(req.params.zoneId);
      if (!zone) {
        throw new ApiError(404, 'not_found', `Zone ${req.params.zoneId} does not exist.`);
      }
      if (userRepo.list().some((user) => user.guestZoneId === zone.id)) {
        throw new ApiError(409, 'zone_in_use', 'A guest is restricted to this zone; change or remove the guest first.');
      }
      if (zone.sensors.length > 0 && force !== 'true') {
        throw new ApiError(409, 'zone_not_empty', 'The zone still has sensors; move them or pass ?force=true.');
      }
      for (const sensor of zone.sensors) {
        sensorRepo.delete(sensor.id);
      }
      zoneRepo.delete(zone.id);
      res.status(204).send();
    },
  );

  router.get('/sensors/discoverable', requireAuth, requireRole('administrator'), (_req, res) => {
    let nodes: DiscoverableNode[];
    try {
      nodes = [...driver.controller.nodes.values()]
        .filter((node) => !node.isControllerNode && sensorRepo.findByNodeId(node.nodeId) === undefined)
        .map((node) => ({
          zwaveNodeId: node.nodeId,
          name: node.name ?? null,
          manufacturer: node.deviceConfig?.manufacturer ?? null,
          product: node.deviceConfig?.label ?? null,
          // Reserved: no reliable signal from zwave-js yet, so the admin always picks the category.
          suggestedCategory: null,
          status: node.status === NodeStatus.Dead ? 'dead' : node.status === NodeStatus.Asleep ? 'asleep' : 'alive',
        }));
    } catch {
      throw new ApiError(503, 'unavailable', 'The zwave-js driver is not ready yet; try again shortly.');
    }
    res.status(200).json(nodes);
  });

  router.patch(
    '/sensors/:sensorId',
    requireAuth,
    requireRole('administrator'),
    validateBody(updateSensorBodySchema),
    (req, res) => {
      const changes = req.body as { name?: string; category?: SensorCategory; zoneId?: string };
      if (!sensorRepo.findById(req.params.sensorId)) {
        throw new ApiError(404, 'not_found', `Sensor ${req.params.sensorId} does not exist.`);
      }
      if (changes.zoneId !== undefined && !zoneRepo.findById(changes.zoneId)) {
        throw new ApiError(404, 'not_found', `Zone ${changes.zoneId} does not exist.`);
      }
      res.status(200).json(sensorRepo.updateConfig(req.params.sensorId, changes));
    },
  );

  router.delete('/sensors/:sensorId', requireAuth, requireRole('administrator'), (req, res) => {
    if (!sensorRepo.findById(req.params.sensorId)) {
      throw new ApiError(404, 'not_found', `Sensor ${req.params.sensorId} does not exist.`);
    }
    sensorRepo.delete(req.params.sensorId);
    res.status(204).send();
  });

  router.post(
    '/zones/:zoneId/sensors',
    requireAuth,
    requireRole('administrator'),
    validateBody(assignSensorBodySchema),
    (req, res) => {
      const { zwaveNodeId, name, category } = req.body as AssignSensorBody;

      let nodeIsKnown: boolean;
      try {
        // `driver.controller` throws until the zwave-js driver finishes
        // starting (src/index.ts defers SensorMapper.start() for the same
        // reason) — treat that as "can't validate yet" rather than a generic 500.
        nodeIsKnown = driver.controller.nodes.get(zwaveNodeId) !== undefined;
      } catch {
        throw new ApiError(503, 'unavailable', 'The zwave-js driver is not ready yet; try again shortly.');
      }
      if (!nodeIsKnown) {
        throw new ApiError(400, 'bad_request', `zwave-js node ${zwaveNodeId} is not known to the driver.`);
      }

      try {
        const sensor = sensorRepo.create({ zwaveNodeId, zoneId: req.params.zoneId, name, category });
        res.status(201).json(sensor);
      } catch (err) {
        if (err instanceof Error && err.message.includes('already assigned')) {
          throw new ApiError(409, 'conflict', err.message);
        }
        if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
          throw new ApiError(404, 'not_found', `Zone ${req.params.zoneId} does not exist.`);
        }
        throw err;
      }
    },
  );

  return router;
}
