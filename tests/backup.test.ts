import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';
import { snapshotDatabase } from '../server/backup-core.js';
describe('consistent backups and restore', () => {
  it('captures committed WAL data and requires the matching secret key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-backup-test-')),
      source = join(directory, 'app.db'),
      snapshot = join(directory, 'backup.db'),
      key = randomBytes(32).toString('hex');
    let db: Store | undefined, restored: Store | undefined;
    try {
      db = new Store(source, key);
      db.setSecret('smtp', { password: 'synthetic-password' });
      db.set('monitor', { synthetic: true });
      snapshotDatabase(source, snapshot);
      restored = new Store(snapshot, key);
      expect(restored.get('monitor')).toEqual({ synthetic: true });
      expect(restored.getSecret('smtp')).toEqual({ password: 'synthetic-password' });
      expect(() => snapshotDatabase(source, snapshot)).toThrow();
      restored.close();
      restored = undefined;
      expect(() => new Store(snapshot, randomBytes(32).toString('hex'))).toThrow();
    } finally {
      db?.close();
      restored?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects a missing source instead of creating an empty database', () => {
    expect(() =>
      snapshotDatabase('missing-synthetic-source.db', 'missing-synthetic-snapshot.db'),
    ).toThrow();
  });
});
