import { describe, it, expect } from 'vitest';
import { Access } from '../server/access.js';
import { MockPlex, memory } from './helpers.js';
import { Store } from '../server/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
describe('access reconciliation', () => {
  it('revokes only the selected server share; retry observes absence before deletion', async () => {
    const db = memory(),
      plex = new MockPlex(),
      access = new Access(
        db,
        () => plex,
        () => 'synthetic',
      );
    await access.change('11', null, '101');
    await access.change('11', null);
    expect(plex.shares.other).toHaveLength(1);
    expect(plex.calls).toEqual([{ server: 'synthetic', share: '101', action: 'revoke' }]);
    db.close();
  });
  it('reports partial bulk failures and rejects replay of preview', async () => {
    const db = memory(),
      plex = new MockPlex();
    plex.shares.synthetic.push({ ...plex.shares.synthetic[0], id: '12', shareId: '102' });
    plex.failUser = '12';
    const access = new Access(
        db,
        () => plex,
        () => 'synthetic',
      ),
      preview = await access.preview(['11', '12'], ['2']);
    const results = await access.apply(preview.ticket);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(plex.shares.synthetic[1].libraries).toEqual(['1']);
    await expect(access.apply(preview.ticket)).rejects.toMatchObject({ code: 'PREVIEW' });
    db.close();
  });
  it('skips bulk changes made outside the app after preview', async () => {
    const db = memory(),
      plex = new MockPlex(),
      access = new Access(
        db,
        () => plex,
        () => 'synthetic',
      ),
      preview = await access.preview(['11'], ['2']);
    plex.shares.synthetic[0].libraries = ['1', '2'];
    const results = await access.apply(preview.ticket);
    expect(results[0].ok).toBe(false);
    expect(plex.calls).toHaveLength(0);
    db.close();
  });
  it('rejects stale share IDs and invalid libraries', async () => {
    const db = memory(),
      plex = new MockPlex(),
      access = new Access(
        db,
        () => plex,
        () => 'synthetic',
      );
    await expect(access.change('11', ['2'], 'stale')).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(access.change('11', ['unknown'], '101')).rejects.toMatchObject({
      code: 'LIBRARIES',
    });
    expect(plex.calls).toHaveLength(0);
    db.close();
  });
  it('executes overdue expiry after restart, reconciling a crash after Plex deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-test-')),
      key = randomBytes(32).toString('hex'),
      file = join(directory, 'app.db');
    try {
      let db = new Store(file, key);
      db.run("INSERT INTO expiries(server,user,due,status) VALUES('synthetic','11',10,'running')");
      db.close();
      db = new Store(file, key);
      const plex = new MockPlex(),
        access = new Access(
          db,
          () => plex,
          () => 'synthetic',
        );
      await access.expire(100);
      expect(db.one<{ status: string }>('SELECT status FROM expiries')?.status).toBe('done');
      expect(plex.calls).toHaveLength(1);
      await access.expire(200);
      expect(plex.calls).toHaveLength(1);
      // Simulate accepted revocation with DB completion not persisted.
      db.run("UPDATE expiries SET status='running'");
      db.close();
      db = new Store(file, key);
      await new Access(
        db,
        () => plex,
        () => 'synthetic',
      ).expire(300);
      expect(plex.calls).toHaveLength(1);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
