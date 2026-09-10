import { Router } from 'express';
import { ApiError } from '../app.js';
import { requireAuth, requireRole } from '../../auth/authorize.js';
import type { HaLinkRepository, HomeAssistantLink } from '../../db/repositories/ha-link-repository.js';

export interface HaLinkRouteDeps {
  haLinkRepo: HaLinkRepository;
}

/** Public-facing HomeAssistantLink shape: never leaks `apiTokenHash` (contracts/rest-api.md's Home Assistant Links section). */
interface PublicHaLink {
  id: string;
  label: string;
  connectionStatus: HomeAssistantLink['connectionStatus'];
  lastSeenAt: number | null;
  createdAt: number;
}

function toPublicHaLink(link: HomeAssistantLink): PublicHaLink {
  return {
    id: link.id,
    label: link.label,
    connectionStatus: link.connectionStatus,
    lastSeenAt: link.lastSeenAt,
    createdAt: link.createdAt,
  };
}

function requireLabel(body: unknown): string {
  const label = (body as { label?: unknown } | null)?.label;
  if (typeof label !== 'string' || label.length === 0) {
    throw new ApiError(400, 'bad_request', 'Body must include a non-empty "label" string.');
  }
  return label;
}

/**
 * `POST /api/v1/ha-links`, `DELETE /api/v1/ha-links/{linkId}` (contracts/rest-api.md's
 * "Home Assistant Links" section), wired to T031's HaLinkRepository —
 * administrator only (FR-010a). The created token's plaintext is returned
 * exactly once, on creation; every other response only ever carries its hash
 * indirectly via the link's `id`.
 */
export function createHaLinkRouter({ haLinkRepo }: HaLinkRouteDeps): Router {
  const router = Router();

  router.post('/ha-links', requireAuth, requireRole('administrator'), (req, res) => {
    const label = requireLabel(req.body);
    // requireRole('administrator') only accepts a session-authenticated
    // caller or an HA-token caller resolved as administrator (authorize.ts's
    // resolveRole) — both populate one of these, so `userId` is always defined here.
    const userId = (req.session?.userId ?? req.haLink?.userId) as string;

    const { link, token } = haLinkRepo.create(label, userId);
    res.status(201).json({ ...toPublicHaLink(link), token });
  });

  router.delete('/ha-links/:linkId', requireAuth, requireRole('administrator'), (req, res) => {
    haLinkRepo.revoke(req.params.linkId);
    res.status(204).send();
  });

  return router;
}
