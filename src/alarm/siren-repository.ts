import type Database from 'better-sqlite3';
import { Repository } from '../db/repository.js';

/** The siren kinds a Z-Wave node can be enrolled as (Ring spec, Sirens). Keypad and camera sirens are not nodes. */
export const SIREN_KINDS = ['BASE', 'DOME', 'OUTDOOR'] as const;
export type SirenKind = (typeof SIREN_KINDS)[number];

/** BASE and DOME run a fixed 10 minutes; only OUTDOOR is configurable, 60-600 s, default 180 s. */
export const FIXED_SIREN_DURATION_SEC = 600;
export const OUTDOOR_MIN_DURATION_SEC = 60;
export const OUTDOOR_MAX_DURATION_SEC = 600;
export const OUTDOOR_DEFAULT_DURATION_SEC = 180;

export interface SirenDevice {
  nodeId: number;
  kind: SirenKind;
  name: string;
  durationSec: number;
  createdAt: number;
}

interface SirenRow {
  node_id: number;
  kind: SirenKind;
  name: string;
  duration_sec: number;
  created_at: number;
}

function toDomain(row: SirenRow): SirenDevice {
  return { nodeId: row.node_id, kind: row.kind, name: row.name, durationSec: row.duration_sec, createdAt: row.created_at };
}

/** The duration a siren of `kind` runs: fixed for BASE/DOME, `requested` (or the default) for OUTDOOR. */
export function resolveDurationSec(kind: SirenKind, requested?: number): number {
  return kind === 'OUTDOOR' ? (requested ?? OUTDOOR_DEFAULT_DURATION_SEC) : FIXED_SIREN_DURATION_SEC;
}

/**
 * Repository for the `sirens` table. Emits `'siren_changed'` (the SirenDevice) on enroll/update and
 * `'siren_removed'` (the node id) on removal, for the Siren driver and the WebSocket stream.
 */
export class SirenRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  list(): SirenDevice[] {
    return this.all<SirenRow>('SELECT * FROM sirens ORDER BY created_at ASC, node_id ASC').map(toDomain);
  }

  findByNodeId(nodeId: number): SirenDevice | undefined {
    const row = this.get<SirenRow>('SELECT * FROM sirens WHERE node_id = ?', nodeId);
    return row ? toDomain(row) : undefined;
  }

  /** Enrolls the node, or updates it if it already is one. */
  upsert(input: { nodeId: number; kind: SirenKind; name?: string; durationSec?: number }): SirenDevice {
    const existing = this.findByNodeId(input.nodeId);
    const siren: SirenDevice = {
      nodeId: input.nodeId,
      kind: input.kind,
      name: input.name ?? existing?.name ?? `${input.kind.charAt(0)}${input.kind.slice(1).toLowerCase()} siren`,
      durationSec: resolveDurationSec(input.kind, input.durationSec ?? (existing?.kind === 'OUTDOOR' ? existing.durationSec : undefined)),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.run(
      `INSERT INTO sirens (node_id, kind, name, duration_sec, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, duration_sec = excluded.duration_sec`,
      siren.nodeId,
      siren.kind,
      siren.name,
      siren.durationSec,
      siren.createdAt,
    );
    this.emit('siren_changed', siren);
    return siren;
  }

  /** Returns true when a siren was removed. */
  delete(nodeId: number): boolean {
    const removed = this.run('DELETE FROM sirens WHERE node_id = ?', nodeId).changes > 0;
    if (removed) {
      this.emit('siren_removed', nodeId);
    }
    return removed;
  }

  /** First-run seed: the legacy SIREN_NODE_ID becomes one BASE siren, only while no siren is enrolled. */
  seedBase(nodeId: number | null): void {
    if (nodeId !== null && this.list().length === 0) {
      this.upsert({ nodeId, kind: 'BASE', name: 'Base siren' });
    }
  }
}
