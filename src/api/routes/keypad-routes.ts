import { Router } from 'express';
import { ApiError } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { chimeBodySchema, validateBody } from '../validation.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import { KeypadNotFoundError, KeypadUnsupportedError, type KeypadService } from '../../keypads/keypad-service.js';

export interface KeypadRouteDeps {
  keypadService: KeypadService;
}

/**
 * `GET /api/v1/keypads` and `POST /api/v1/keypads/{nodeId}/chime` (the keypad contract). Nothing
 * here knows which keypad models exist: capabilities and chime sounds come from each keypad's adapter.
 */
export function createKeypadRouter({ keypadService }: KeypadRouteDeps): Router {
  const router = Router();

  router.get('/keypads', requireAuth, requireRole('administrator', 'member'), (_req, res) => {
    res.status(200).json({ keypads: keypadService.list() });
  });

  router.post(
    '/keypads/:nodeId/chime',
    requireAuth,
    requireRole('administrator', 'member'),
    validateBody(chimeBodySchema),
    asyncHandler(async (req, res) => {
      const nodeId = Number(req.params.nodeId);
      const { sound, volume } = req.body as { sound: string; volume?: number };
      if (!Number.isInteger(nodeId) || !keypadService.has(nodeId)) {
        throw new ApiError(404, 'not_found', 'No keypad with that node id.');
      }

      try {
        await keypadService.chime(nodeId, sound, volume);
      } catch (err) {
        if (err instanceof KeypadNotFoundError) {
          throw new ApiError(404, 'not_found', err.message);
        }
        if (err instanceof KeypadUnsupportedError) {
          throw new ApiError(400, 'bad_request', err.message);
        }
        throw err;
      }
      res.status(204).end();
    }),
  );

  return router;
}
