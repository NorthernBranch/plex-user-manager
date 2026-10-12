import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { communicationFixture } from './communication-helpers.js';
import { noPreferences } from '../server/communication-preferences.js';
import type { Delivery } from '../server/email.js';
import { Access } from '../server/access.js';

const fixtures: ReturnType<typeof communicationFixture>[] = [];
function fixture() {
  const f = communicationFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => fixtures.splice(0).forEach((f) => f.store.close()));
describe('welcome membership evidence', () => {
  it('does not welcome pre-existing users on enable, supports explicit idempotent resend and preview', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    f.communications.configure({
      ...f.communications.settings(),
      welcome: { ...f.communications.settings().welcome, enabled: true },
    });
    await f.communications.tick(now);
    await f.queue.drain(now);
    expect(f.sender).not.toHaveBeenCalled();
    expect(await f.communications.welcomePreview('11')).toMatchObject({
      body: expect.stringContaining('Sample Films'),
    });
    const requestId = randomUUID();
    await f.communications.welcome('11', requestId, true, now);
    await f.communications.welcome('11', requestId, true, now);
    await f.queue.drain(now);
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.sender.mock.calls[0][1].text).not.toContain('synthetic-token');
  });
  it('welcomes only an observed pending-to-accepted transition with stable IDs and confirmed access', async () => {
    const f = fixture(),
      now = Date.now();
    f.communications.configure({
      ...f.communications.settings(),
      welcome: { ...f.communications.settings().welcome, enabled: true },
    });
    f.plex.shares.synthetic[0].kind = 'pending';
    await f.communications.tick(now);
    await expect(f.communications.welcome('11', randomUUID(), true, now)).rejects.toMatchObject({
      code: 'MEMBERSHIP',
    });
    f.plex.shares.synthetic[0].kind = 'shared';
    await f.contact();
    await f.communications.tick(now + 30000);
    await f.queue.drain(now + 30000);
    f.communications.restart();
    await f.communications.tick(now + 60000);
    await f.queue.drain(now + 60000);
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.store.one<{ welcome: string }>('SELECT welcome FROM memberships')?.welcome).toBe(
      'sent',
    );
    f.plex.shares.synthetic = [];
    await f.communications.tick(now + 90000);
    f.plex.shares.synthetic = [
      {
        id: '11',
        name: 'Sample viewer',
        kind: 'pending',
        shareId: '101',
        libraries: ['1'],
        filters: {},
      },
    ];
    await f.communications.tick(now + 120000);
    f.plex.shares.synthetic[0].kind = 'shared';
    await f.communications.tick(now + 150000);
    await f.queue.drain(now + 150000);
    expect(f.sender).toHaveBeenCalledTimes(2);
    expect(
      f.store.one<{ generation: number }>('SELECT generation FROM memberships')?.generation,
    ).toBe(2);
  });
  it('never matches acceptance by name or email when pending share identifiers change', async () => {
    const f = fixture(),
      now = Date.now();
    f.communications.configure({
      ...f.communications.settings(),
      welcome: { ...f.communications.settings().welcome, enabled: true },
    });
    f.plex.shares.synthetic[0].kind = 'pending';
    await f.communications.tick(now);
    f.plex.shares.synthetic[0] = {
      ...f.plex.shares.synthetic[0],
      kind: 'shared',
      shareId: 'replacement',
    };
    await f.contact();
    await f.communications.tick(now + 30000);
    await f.queue.drain(now + 30000);
    expect(f.sender).not.toHaveBeenCalled();
    expect(
      f.store
        .all<{ welcome: string }>('SELECT welcome FROM memberships')
        .every((m) => m.welcome === 'baseline'),
    ).toBe(true);
  });
  it('does not send welcome without verified consent, and suppresses queued welcome after access is removed', async () => {
    const f = fixture(),
      now = Date.now(),
      c = await f.contact('11', 'viewer@example.com', false);
    await expect(f.communications.welcome('11', randomUUID(), true, now)).rejects.toMatchObject({
      code: 'CONTACT',
    });
    f.store.run('UPDATE addresses SET verified_at=? WHERE email=?', now, c.email);
    await f.contacts.save(c.id, { ...c, preferences: noPreferences });
    await expect(f.communications.welcome('11', randomUUID(), true, now)).rejects.toMatchObject({
      code: 'CONTACT',
    });
    await f.contacts.save(c.id, { ...c, preferences: c.preferences });
    await f.communications.welcome('11', randomUUID(), true, now);
    f.plex.shares.synthetic = [];
    await f.queue.drain(now);
    expect(f.sender).not.toHaveBeenCalled();
    expect(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status).toBe(
      'suppressed',
    );
  });
});
describe('expiry reminders and revocation failure notices', () => {
  it('uses a fake clock to process the latest overdue reminder at startup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const f = fixture(),
        now = Date.now();
      await f.contact();
      enable(f, now, [3600, 1800, 600]);
      vi.setSystemTime(new Date(now + 3300000));
      f.communications.restart();
      await f.communications.tick();
      await f.queue.drain();
      expect(f.sender).toHaveBeenCalledTimes(2);
      expect(
        f.store.all("SELECT * FROM communication_jobs WHERE status='superseded'"),
      ).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
  function enable(f: ReturnType<typeof fixture>, now: number, leads = [3600, 600]) {
    f.communications.configure({
      ...f.communications.settings(),
      expiry: {
        ...f.communications.settings().expiry,
        enabled: true,
        user: true,
        leads,
        administrators: ['administrator@example.com'],
        instructions: 'Contact the server administrator.',
      },
    });
    f.store.run(
      "INSERT INTO expiries(server,user,due,status) VALUES('synthetic','11',?,'pending')",
      now + 3600000,
    );
  }
  it('sends only the latest missed lead separately to the user and administrator after restart', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    enable(f, now, [3600, 1800, 600]);
    f.communications.restart();
    await f.communications.tick(now + 3300000);
    await f.queue.drain(now + 3300000);
    expect(f.sender).toHaveBeenCalledTimes(2);
    expect(f.sender.mock.calls.map(([, msg]) => msg.to).sort()).toEqual([
      'administrator@example.com',
      'viewer@example.com',
    ]);
    expect(
      f.sender.mock.calls.every(([, msg]) =>
        msg.text.includes(new Date(now + 3600000).toISOString()),
      ),
    ).toBe(true);
    await f.communications.tick(now + 3360000);
    await f.queue.drain(now + 3360000);
    expect(f.sender).toHaveBeenCalledTimes(2);
    await f.communications.tick(now + 3600000);
    await f.queue.drain(now + 3600000);
    expect(f.sender).toHaveBeenCalledTimes(2);
  });
  it('invalidates queued reminders on expiry edits, cancellation, removal and settings changes', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    enable(f, now);
    await f.communications.tick(now);
    f.store.run('UPDATE expiries SET due=?,revision=revision+1', now + 7200000);
    f.communications.invalidateExpiry('synthetic', '11');
    await f.queue.drain(now);
    expect(f.sender).not.toHaveBeenCalled();
    await f.communications.tick(now + 3600000);
    f.communications.configure({
      ...f.communications.settings(),
      expiry: { ...f.communications.settings().expiry, enabled: false },
    });
    await f.queue.drain(now + 3600000);
    expect(f.sender).not.toHaveBeenCalled();
    f.store.run("UPDATE expiries SET status='cancelled',revision=revision+1");
    await f.communications.tick(now + 7200000);
    expect(f.store.all<Delivery>("SELECT * FROM deliveries WHERE status='sent'")).toHaveLength(0);
  });
  it('suppresses queued reminders if membership has already gone or invitation remains pending', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    enable(f, now);
    await f.communications.tick(now);
    f.plex.shares.synthetic[0].kind = 'pending';
    await f.queue.drain(now);
    expect(f.sender).not.toHaveBeenCalled();
    expect(
      f.store.all<Delivery>('SELECT * FROM deliveries').every((d) => d.status === 'suppressed'),
    ).toBe(true);
  });
  it('admin and user roles sharing one address receive one reminder', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    enable(f, now);
    f.communications.configure({
      ...f.communications.settings(),
      expiry: { ...f.communications.settings().expiry, administrators: ['viewer@example.com'] },
    });
    await f.communications.tick(now);
    await f.queue.drain(now);
    expect(f.sender).toHaveBeenCalledTimes(1);
  });
  it('reports failed revocation only to administrators without claiming access is gone', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    enable(f, now);
    f.store.run('UPDATE expiries SET due=?', now - 1000);
    f.plex.revoke = async () => {
      throw new Error('Synthetic revocation failure');
    };
    await new Access(
      f.store,
      () => f.plex,
      () => 'synthetic',
    ).expire(now);
    vi.spyOn(f.plex, 'users').mockRejectedValue(new Error('Synthetic Plex account-service outage'));
    await f.communications.tick(now);
    await f.queue.drain(now);
    expect(f.sender.mock.calls.map(([, msg]) => msg.to)).toEqual(['administrator@example.com']);
    expect(f.sender.mock.calls[0][1].text).toContain('Access may remain');
    await f.communications.tick(now + 60000);
    await f.queue.drain(now + 60000);
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.plex.shares.synthetic).toHaveLength(1);
  });
});
