import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/schema.js';
import { Repository } from '../../src/db/repository.js';

interface Zone {
  id: string;
  name: string;
  created_at: number;
}

// A minimal concrete subclass exercising the protected run/get/all/transaction
// helpers the way a real per-entity repository (built in later phases) would.
class ZoneRepository extends Repository {
  constructor(db: Database.Database) {
    super(db);
  }

  insert(zone: Zone): void {
    this.run('INSERT INTO zones (id, name, created_at) VALUES (?, ?, ?)', zone.id, zone.name, zone.created_at);
  }

  findById(id: string): Zone | undefined {
    return this.get<Zone>('SELECT * FROM zones WHERE id = ?', id);
  }

  findAll(): Zone[] {
    return this.all<Zone>('SELECT * FROM zones ORDER BY id');
  }

  insertAllOrNothing(zones: Zone[]): void {
    const insertAll = this.transaction((rows: Zone[]) => {
      for (const zone of rows) {
        this.insert(zone);
      }
    });
    insertAll(zones);
  }
}

describe('Repository base', () => {
  it('runs an insert and reads it back with get/all', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));
    repo.insert({ id: 'zone-1', name: 'Garage', created_at: 0 });

    expect(repo.findById('zone-1')).toEqual({ id: 'zone-1', name: 'Garage', created_at: 0 });
    expect(repo.findAll()).toEqual([{ id: 'zone-1', name: 'Garage', created_at: 0 }]);
    expect(repo.findById('missing')).toBeUndefined();
  });

  it('commits all statements in a transaction atomically', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));
    repo.insertAllOrNothing([
      { id: 'zone-1', name: 'Garage', created_at: 0 },
      { id: 'zone-2', name: 'Backyard', created_at: 1 },
    ]);

    expect(repo.findAll()).toHaveLength(2);
  });

  it('rolls back every statement when one fails inside a transaction', () => {
    const repo = new ZoneRepository(createDatabase(':memory:'));

    expect(() =>
      repo.insertAllOrNothing([
        { id: 'zone-1', name: 'Garage', created_at: 0 },
        { id: 'zone-1', name: 'Duplicate id', created_at: 1 }, // violates PRIMARY KEY
      ]),
    ).toThrow(/UNIQUE constraint failed/);

    expect(repo.findAll()).toEqual([]);
  });
});
