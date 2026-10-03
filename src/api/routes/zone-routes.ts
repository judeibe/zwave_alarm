import { Router } from 'express';
import type { Driver } from 'zwave-js';
import { ApiError } from '../app.js';
import { assignSensorBodySchema, createZoneBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { ZoneRepository } from '../../db/repositories/zone-repository.js';
import type { SensorCategory, SensorRepository } from '../../db/repositories/sensor-repository.js';

export interface ZoneRouteDeps {
  zoneRepo: ZoneRepository;
  sensorRepo: SensorRepository;
  /** Only `controller.nodes` is read (to validate a zwaveNodeId is known before assigning it). */
  driver: Pick<Driver, 'controller'>;
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
export function createZoneRouter({ zoneRepo, sensorRepo, driver }: ZoneRouteDeps): Router {
  const router = Router();

  router.get('/zones', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json(zoneRepo.list());
  });

  router.post('/zones', requireAuth, requireRole('administrator'), validateBody(createZoneBodySchema), (req, res) => {
    const { name } = req.body as { name: string };
    res.status(201).json(zoneRepo.create(name));
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
