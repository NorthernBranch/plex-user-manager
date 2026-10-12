import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  acceptHeartbeat,
  signature,
  sendHeartbeat,
  heartbeatAcknowledgement,
} from '../server/heartbeat.js';
import { memory, monitorSettings } from './helpers.js';
import { Monitor } from '../server/monitor.js';
import { ExternalMonitor } from '../server/external-monitor.js';
import { communicationFixture } from './communication-helpers.js';
describe('external heartbeat boundary', () => {
  it('does not show an old matching acknowledgement as current after local edits or time passes', async () => {
    const f = communicationFixture(),
      worker = memory(),
      key = randomBytes(32).toString('hex');
    try {
      worker.set('monitor', f.store.get('monitor'));
      f.store.setSecret('heartbeat', { url: 'https://monitor.example.com/heartbeat', key });
      await sendHeartbeat(
        f.store,
        'healthy',
        async (_url, init) =>
          new Response(null, {
            status: 204,
            headers: heartbeatAcknowledgement(worker, JSON.parse(String(init?.body)).nonce, key),
          }),
      );
      expect(f.communications.list().external).toMatchObject({
        maintenanceMatch: true,
        recipientsMatch: true,
        stale: false,
      });
      f.store.set(
        'monitor',
        monitorSettings({
          maintenance: [{ start: '2030-01-01T00:00:00.000Z', end: '2030-01-01T01:00:00.000Z' }],
        }),
      );
      expect(f.communications.list().external).toMatchObject({
        maintenanceMatch: false,
        recipientsMatch: false,
      });
      const status = f.store.get<Record<string, unknown>>('heartbeat.delivery')!;
      f.store.set('heartbeat.delivery', { ...status, at: Date.now() - 300000 });
      expect(f.communications.list().external).toMatchObject({
        stale: true,
        maintenanceMatch: null,
        recipientsMatch: null,
      });
    } finally {
      f.store.close();
      worker.close();
    }
  });
  it('authenticates configuration acknowledgements and displays mismatches or unknown state', async () => {
    const local = memory(),
      worker = memory(),
      key = randomBytes(32).toString('hex');
    try {
      local.set('monitor', monitorSettings());
      worker.set('monitor', monitorSettings());
      local.setSecret('heartbeat', { url: 'https://monitor.example.com/heartbeat', key });
      const respond = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const nonce = JSON.parse(String(init?.body)).nonce as string;
        return new Response(null, {
          status: 204,
          headers: heartbeatAcknowledgement(worker, nonce, key),
        });
      };
      await sendHeartbeat(local, 'healthy', respond);
      expect(local.get('heartbeat.delivery')).toMatchObject({
        ok: true,
        configurationAuthenticated: true,
        maintenanceMatch: true,
        recipientsMatch: true,
      });
      worker.set(
        'monitor',
        monitorSettings({
          recipients: [],
          maintenance: [{ start: '2030-01-01T00:00:00.000Z', end: '2030-01-01T01:00:00.000Z' }],
        }),
      );
      await sendHeartbeat(local, 'healthy', respond);
      expect(local.get('heartbeat.delivery')).toMatchObject({
        maintenanceMatch: false,
        recipientsMatch: false,
      });
      await sendHeartbeat(
        local,
        'healthy',
        async () =>
          new Response(null, {
            status: 204,
            headers: heartbeatAcknowledgement(worker, 'replayed-nonce', key),
          }),
      );
      expect(local.get('heartbeat.delivery')).toMatchObject({
        configurationAuthenticated: false,
        maintenanceMatch: null,
        recipientsMatch: null,
      });
    } finally {
      local.close();
      worker.close();
    }
  });
  it('rejects forged, stale and replayed heartbeats', () => {
    const db = memory(),
      key = randomBytes(32).toString('hex'),
      body = JSON.stringify({ at: 100000, nonce: randomUUID(), state: 'healthy' });
    expect(acceptHeartbeat(db, body, 'wrong', key, 100000)).toBe(false);
    expect(acceptHeartbeat(db, body, signature(body, key), key, 200000)).toBe(false);
    expect(acceptHeartbeat(db, body, signature(body, key), key, 100000)).toBe(true);
    expect(acceptHeartbeat(db, body, signature(body, key), key, 100000)).toBe(false);
    db.close();
  });
  it('sends only scoped health, with no Plex credentials or recipient configuration', async () => {
    const db = memory();
    db.setSecret('heartbeat', {
      url: 'https://monitor.example.com/heartbeat',
      key: randomBytes(32).toString('hex'),
    });
    db.setSecret('plex', { token: 'synthetic-owner-token' });
    let data = '';
    await sendHeartbeat(db, 'healthy', async (_input, init) => {
      data = String(init?.body);
      return new Response(null, { status: 204 });
    });
    expect(data).not.toContain('synthetic-owner-token');
    expect(JSON.parse(data).state).toBe('healthy');
    expect(db.get<{ ok: boolean }>('heartbeat.delivery')?.ok).toBe(true);
    db.close();
  });
  it('persists an external outage and email jobs without a NAS connection', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const monitor = new Monitor(db, 'External heartbeat', false),
      external = new ExternalMonitor(db, monitor, 30);
    db.set('heartbeat.received', { at: 0, nonce: randomUUID(), state: 'healthy' });
    for (const t of [30000, 35000, 40000, 45000]) external.tick(t);
    expect(db.all('SELECT * FROM incidents')).toHaveLength(1);
    expect(db.all('SELECT * FROM deliveries')).toHaveLength(2);
    db.close();
  });
  it('does not interpret unknown or maintenance as confirmed recovery', () => {
    const db = memory();
    db.set('monitor', monitorSettings());
    const monitor = new Monitor(db, 'External heartbeat', false),
      external = new ExternalMonitor(db, monitor, 30);
    db.set('heartbeat.received', { at: 0, nonce: randomUUID(), state: 'unhealthy' });
    for (const t of [0, 5000, 10000, 15000]) external.tick(t);
    db.set('heartbeat.received', { at: 20000, nonce: randomUUID(), state: 'maintenance' });
    external.tick(20000);
    external.tick(25000);
    expect(monitor.state().unknown).toBe(true);
    expect(db.one<{ recovered: null }>('SELECT recovered FROM incidents')?.recovered).toBeNull();
    db.close();
  });
});
