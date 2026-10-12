import { describe, it, expect, vi } from 'vitest';
import { Access } from '../server/access.js';
import { MockPlex, memory } from './helpers.js';
import { Store } from '../server/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Plex } from '../server/plex.js';
describe('access reconciliation', () => {
  it('never completes expiry when the real adapter receives malformed absence evidence', async () => {
    const db = memory();
    let malformed = true;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      expect(options?.method).toBe('GET');
      return new Response(malformed ? '{}' : '<MediaContainer size="0"/>');
    });
    const adapter = new Plex('synthetic-token', 'test-client', fetcher);
    const access = new Access(
      db,
      () => adapter,
      () => 'synthetic',
    );
    try {
      db.run("INSERT INTO expiries(server,user,due,status) VALUES('synthetic','11',10,'pending')");
      await access.expire(100);
      expect(
        db.one<{ status: string; attempts: number }>('SELECT status,attempts FROM expiries'),
      ).toMatchObject({ status: 'pending', attempts: 1 });
      malformed = false;
      await access.expire(120100);
      expect(db.one<{ status: string }>('SELECT status FROM expiries')?.status).toBe('done');
      expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    } finally {
      db.close();
    }
  });
  it('does not confirm revocation when its readback response is malformed', async () => {
    const db = memory();
    let revoked = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (options?.method === 'DELETE') {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      if (revoked) return new Response('{}');
      if (String(url).includes('shared_servers'))
        return new Response(
          '<MediaContainer><SharedServer><Section id="1" shared="1"/></SharedServer></MediaContainer>',
        );
      return new Response(
        String(url).includes('/api/users/')
          ? '<MediaContainer><User id="11"><Server id="101" machineIdentifier="synthetic"/></User></MediaContainer>'
          : '<MediaContainer/>',
      );
    });
    try {
      const access = new Access(
        db,
        () => new Plex('synthetic-token', 'test-client', fetcher),
        () => 'synthetic',
      );
      await expect(access.change('11', null, '101')).rejects.toMatchObject({ code: 'PLEX_SCHEMA' });
      expect(db.all("SELECT * FROM audit WHERE result='confirmed'")).toHaveLength(0);
      expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(
        1,
      );
    } finally {
      db.close();
    }
  });
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
