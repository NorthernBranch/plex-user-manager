import { describe, it, expect } from 'vitest';
import { Monitor } from '../server/monitor.js';
import { memory, monitorSettings } from './helpers.js';
import { Store } from '../server/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

describe('persisted incidents', () => {
  it('discards a probe result if integration or monitoring settings changed in flight', async () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const m = new Monitor(db);
    let release: () => void = () => {};
    const probe = m.probe(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      10000,
    );
    m.restart(10000);
    release();
    expect(await probe).toBeUndefined();
    expect(m.state().unknown).toBe(true);
    db.close();
  });
  it('suppresses brief interruptions below the threshold', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const monitor = new Monitor(db);
    monitor.observe(false, 0);
    monitor.observe(false, 5000);
    monitor.observe(true, 10000);
    expect(db.all('SELECT * FROM incidents')).toHaveLength(0);
    expect(db.all('SELECT * FROM deliveries')).toHaveLength(0);
    expect(monitor.state().state).toBe('healthy');
    db.close();
  });
  it('confirms one incident at threshold and controls flapping', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const m = new Monitor(db);
    for (const t of [0, 5000, 10000, 15000, 20000]) m.observe(false, t);
    expect(db.all('SELECT * FROM incidents')).toHaveLength(1);
    expect(db.all("SELECT * FROM deliveries WHERE kind='outage'")).toHaveLength(2);
    db.run("UPDATE deliveries SET status='sent'");
    m.observe(true, 25000);
    expect(m.state().state).toBe('recovery pending');
    m.observe(false, 30000);
    expect(m.state().state).toBe('confirmed outage');
    m.observe(true, 35000);
    m.observe(true, 40000);
    expect(m.state().state).toBe('recovered');
    expect(db.all("SELECT * FROM deliveries WHERE kind='recovery'")).toHaveLength(2);
    m.observe(true, 45000);
    expect(db.all('SELECT * FROM deliveries')).toHaveLength(4);
    db.close();
  });
  it('supersedes stale outages and suppresses recovery for unsent recipients', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const m = new Monitor(db);
    for (const t of [0, 5000, 10000, 15000]) m.observe(false, t);
    m.observe(true, 20000);
    m.observe(true, 25000);
    expect(
      db
        .all<{ status: string }>("SELECT status FROM deliveries WHERE kind='outage'")
        .map((x) => x.status),
    ).toEqual(['superseded', 'superseded']);
    expect(
      db
        .all<{ status: string }>("SELECT status FROM deliveries WHERE kind='recovery'")
        .map((x) => x.status),
    ).toEqual(['suppressed', 'suppressed']);
    db.close();
  });
  it('suppresses maintenance and external-authority local notifications', () => {
    for (const overrides of [
      { maintenance: [{ start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:01:00.000Z' }] },
      { authority: 'external' as const },
    ]) {
      const db = memory();
      db.set('monitor', monitorSettings(overrides));
      const m = new Monitor(db);
      for (const t of [0, 5000, 10000, 15000]) m.observe(false, t);
      expect(
        db
          .all<{ status: string }>('SELECT status FROM deliveries')
          .every((r) => r.status === 'suppressed'),
      ).toBe(true);
      db.close();
    }
  });
  it('keeps incidents across restart while excluding unobserved time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-monitor-test-')),
      key = randomBytes(32).toString('hex'),
      file = join(directory, 'app.db');
    try {
      let db = new Store(file, key);
      db.set('monitor', monitorSettings());
      let m = new Monitor(db);
      for (const t of [0, 5000, 10000, 15000]) m.observe(false, t);
      db.close();
      db = new Store(file, key);
      m = new Monitor(db);
      m.restart(100000);
      expect(m.state().unknown).toBe(true);
      m.observe(false, 100000);
      expect(db.one<{ observed: number }>('SELECT observed FROM incidents')?.observed).toBe(15000);
      expect(db.all('SELECT * FROM incidents')).toHaveLength(1);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not assume pre-restart suspicion remains continuous', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const m = new Monitor(db);
    m.observe(false, 0);
    m.observe(false, 5000);
    m.restart(50000);
    m.observe(false, 50000);
    expect(db.all('SELECT * FROM incidents')).toHaveLength(0);
    m.observe(false, 70000);
    expect(db.all('SELECT * FROM incidents')).toHaveLength(0);
    db.close();
  });
  it('prevents overlapping probes', async () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const m = new Monitor(db);
    let count = 0,
      release: () => void = () => {};
    const first = m.probe(async () => {
      count++;
      await new Promise<void>((r) => {
        release = r;
      });
    }, 0);
    await m.probe(async () => {
      count++;
    }, 1);
    release();
    await first;
    expect(count).toBe(1);
    db.close();
  });
});
