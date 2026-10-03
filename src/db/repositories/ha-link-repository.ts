import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { Repository } from '../repository.js';
import { hashToken } from '../../auth/token.js';

export type HaLinkConnectionStatus = 'connected' | 'disconnected';

/** data-model.md's HomeAssistantLink entity. */
export interface HomeAssistantLink {
  id: string;
  apiTokenHash: string;
  label: string;
  connectionStatus: HaLinkConnectionStatus;
  lastSeenAt: number | null;
  createdAt: number;
  /** The administrator who issued this link's token (data-model.md's relationship), for SecurityEvent.sourceUserId audit purposes. */
  userId: string;
}

/** `create`'s only return shape — the plaintext token is never stored, so this is the one chance to hand it back. */
export interface CreatedHaLink {
  link: HomeAssistantLink;
  token: string;
}

interface HaLinkRow {
  id: string;
  api_token_hash: string;
  label: string;
  connection_status: HaLinkConnectionStatus;
  last_seen_at: number | null;
  created_at: number;
  user_id: string;
}

function toDomain(row: HaLinkRow): HomeAssistantLink {
  return {
    id: row.id,
    apiTokenHash: row.api_token_hash,
    label: row.label,
    connectionStatus: row.connection_status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    userId: row.user_id,
  };
}

/** Repository for the `ha_links` table (data-model.md's HomeAssistantLink entity). */
export class HaLinkRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  /**
   * Issues a new long-lived bearer token on behalf of `userId` (the
   * administrator issuing it), labeled `label`. Only the token's hash
   * (src/auth/token.ts's `hashToken`, shared with `requireHaToken`'s lookup)
   * is persisted — the plaintext is returned here and nowhere else, per
   * contracts/rest-api.md's `POST /api/v1/ha-links`.
   */
  create(label: string, userId: string): CreatedHaLink {
    const token = randomBytes(32).toString('hex');
    const link: HomeAssistantLink = {
      id: randomUUID(),
      apiTokenHash: hashToken(token),
      label,
      connectionStatus: 'disconnected',
      lastSeenAt: null,
      createdAt: Date.now(),
      userId,
    };
    this.run(
      `INSERT INTO ha_links (id, api_token_hash, label, connection_status, last_seen_at, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      link.id,
      link.apiTokenHash,
      link.label,
      link.connectionStatus,
      link.lastSeenAt,
      link.createdAt,
      link.userId,
    );
    return { link, token };
  }

  /** Looks up a link by its token's hash (src/auth/token.ts's `requireHaToken` resolves bearer tokens this way). */
  findByTokenHash(apiTokenHash: string): HomeAssistantLink | undefined {
    const row = this.get<HaLinkRow>('SELECT * FROM ha_links WHERE api_token_hash = ?', apiTokenHash);
    return row ? toDomain(row) : undefined;
  }

  list(): HomeAssistantLink[] {
    return this.all<HaLinkRow>('SELECT * FROM ha_links ORDER BY created_at ASC').map(toDomain);
  }

  /** Revokes a previously issued token, per contracts/rest-api.md's `DELETE /api/v1/ha-links/{linkId}`. */
  revoke(id: string): void {
    this.run('DELETE FROM ha_links WHERE id = ?', id);
  }
}
