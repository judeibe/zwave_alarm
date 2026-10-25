import { Router } from 'express';
import type { Driver } from 'zwave-js';
import { ApiError } from '../app.js';
import { sirenBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { SirenKind, SirenRepository } from '../../alarm/siren-repository.js';

export interface SirenRouteDeps {
  sirenRepo: SirenRepository;
  /** Only `controller.nodes` is read, to check the node exists before it is enrolled. */
  driver: Pick<Driver, 'controller'>;
}

function parseNodeId(value: string): number {
  const nodeId = Number(value);
  if (!Number.isInteger(nodeId) || nodeId < 1) {
    throw new ApiError(400, 'bad_request', 'nodeId must be a positive integer.');
  }
  return nodeId;
}

/**
 * `GET /sirens`, `PUT /sirens/{nodeId}`, `DELETE /sirens/{nodeId}`: the Z-Wave nodes that sound when an alarm
 * does. Only an administrator enrols or removes one; an `OUTDOOR` siren's duration (60-600 s, default 180) is
 * the only configurable one.
 */
export function createSirenRouter({ sirenRepo, driver }: SirenRouteDeps): Router {
  const router = Router();

  router.get('/sirens', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json(sirenRepo.list());
  });

  router.put(
    '/sirens/:nodeId',
    requireAuth,
    requireRole('administrator'),
    validateBody(sirenBodySchema),
    (req, res) => {
      const nodeId = parseNodeId(req.params.nodeId);
      const { kind, name, durationSec } = req.body as { kind: SirenKind; name?: string; durationSec?: number };
      if (durationSec !== undefined && kind !== 'OUTDOOR') {
        throw new ApiError(400, 'bad_request', 'Only an OUTDOOR siren has a configurable duration.');
      }
      let known: boolean;
      try {
        known = driver.controller.nodes.get(nodeId) !== undefined;
      } catch {
        throw new ApiError(503, 'unavailable', 'The zwave-js driver is not ready yet; try again shortly.');
      }
      if (!known) {
        throw new ApiError(400, 'bad_request', `zwave-js node ${String(nodeId)} is not known to the driver.`);
      }
      res.status(200).json(sirenRepo.upsert({ nodeId, kind, name, durationSec }));
    },
  );

  router.delete('/sirens/:nodeId', requireAuth, requireRole('administrator'), (req, res) => {
    const nodeId = parseNodeId(req.params.nodeId);
    if (!sirenRepo.delete(nodeId)) {
      throw new ApiError(404, 'not_found', `Siren ${String(nodeId)} is not enrolled.`);
    }
    res.status(204).send();
  });

  return router;
}
