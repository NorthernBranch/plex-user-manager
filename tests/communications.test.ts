import { afterEach, describe, it, expect, vi } from 'vitest';
import { communicationFixture } from './communication-helpers.js';
import { noPreferences } from '../server/communication-preferences.js';
import { effectiveMonitorSettings } from '../server/maintenance.js';
import { Monitor } from '../server/monitor.js';
import type { Delivery } from '../server/email.js';

const fixtures: ReturnType<typeof communicationFixture>[] = [];
function fixture() {
  const f = communicationFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => fixtures.splice(0).forEach((f) => f.store.close()));
async function campaign(
  f: ReturnType<typeof fixture>,
  now: number,
  overrides: Record<string, unknown> = {},
) {
  const row = f.communications.save(undefined, { ...f.draft, ...overrides }, now);
  const preview = await f.communications.preview(row.id, now);
  f.communications.confirm(row.id, preview.ticket, null, true, now);
  return row;
}
describe('announcement audiences and durable schedules', () => {
  it('deduplicates shared addresses and fixes the audience at final confirmation', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    await f.contact(null);
    const row = f.communications.save(undefined, f.draft, now),
      preview = await f.communications.preview(row.id, now);
    expect(preview).toMatchObject({ includedCount: 1, duplicateCount: 1 });
    f.communications.confirm(row.id, preview.ticket, now + 60000, true, now);
    await f.contact(null, 'late@example.com');
    await f.communications.tick(now);
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(0);
    f.communications.restart();
    await f.communications.tick(now + 60000);
    await f.communications.tick(now + 61000);
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(1);
    await f.queue.drain(now + 61000);
    expect(f.sender.mock.calls.map(([, msg]) => msg.to)).toEqual(['viewer@example.com']);
    expect(f.store.one<{ status: string }>('SELECT status FROM communication_jobs')?.status).toBe(
      'dispatched',
    );
    expect(() => f.communications.confirm(row.id, preview.ticket, null, true, now)).toThrow();
  });
  it('shows unverified, opted-out, absent and library exclusions without guessed email addresses', async () => {
    const f = fixture(),
      now = Date.now();
    const c = await f.contact('11', 'unverified@example.com', false);
    await f.contact(null, 'standalone@example.com');
    const row = f.communications.save(
      undefined,
      { ...f.draft, rule: { mode: 'libraries', ids: ['2'] } },
      now,
    );
    const first = await f.communications.preview(row.id, now);
    expect(first.includedCount).toBe(0);
    expect(first.excludedCount).toBe(2);
    f.store.run('UPDATE addresses SET verified_at=? WHERE email=?', now, c.email);
    expect(
      (await f.communications.preview(row.id, now)).excluded.some((r) =>
        /libraries/.test(r.reason),
      ),
    ).toBe(true);
    f.plex.shares.synthetic[0].libraries = ['2'];
    expect((await f.communications.preview(row.id, now)).includedCount).toBe(1);
    f.plex.shares.synthetic = [];
    expect((await f.communications.preview(row.id, now)).includedCount).toBe(0);
  });
  it('rechecks preferences, membership and address changes after scheduling and dispatch', async () => {
    const f = fixture(),
      now = Date.now(),
      c = await f.contact();
    await campaign(f, now);
    await f.communications.tick(now);
    await f.contacts.save(c.id, { ...c, preferences: noPreferences });
    await f.queue.drain(now);
    expect(f.sender).not.toHaveBeenCalled();
    expect(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status).toBe(
      'suppressed',
    );
    await f.contacts.save(c.id, { ...c, preferences: { ...c.preferences } });
    await campaign(f, now + 1000);
    f.plex.shares.synthetic = [];
    await f.communications.tick(now + 31000);
    await f.queue.drain(now + 31000);
    expect(f.sender).not.toHaveBeenCalled();
  });
  it('cancels future campaigns without dispatch and invalidates old previews after edits', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    const row = f.communications.save(undefined, f.draft, now),
      preview = await f.communications.preview(row.id, now);
    f.communications.save(row.id, { ...f.draft, body: 'Updated content.' }, now);
    expect(() => f.communications.confirm(row.id, preview.ticket, null, true, now)).toThrow();
    const fresh = await f.communications.preview(row.id, now);
    f.communications.confirm(row.id, fresh.ticket, now + 60000, true, now);
    f.communications.action(row.id, 'cancel', false, true, now + 1000);
    await f.communications.tick(now + 60000);
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(0);
    expect(f.store.one<{ status: string }>('SELECT status FROM communication_jobs')?.status).toBe(
      'superseded',
    );
  });
  it('does not interpret a failed Plex refresh as absence, and bounds dispatch retries', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    await campaign(f, now);
    const spy = vi
      .spyOn(f.plex, 'users')
      .mockRejectedValue(new Error('Synthetic integration unavailable'));
    for (let i = 0; i < 5; i++) await f.communications.tick(now + i * 3600000);
    expect(
      f.store.one<{ status: string; attempts: number }>(
        'SELECT status,attempts FROM communication_jobs',
      ),
    ).toMatchObject({ status: 'failed', attempts: 5 });
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(0);
    expect(f.store.get('communications.integration')).toMatchObject({ ok: false });
    spy.mockRestore();
    f.communications.retryJob(f.store.one<{ id: string }>('SELECT id FROM communication_jobs')!.id);
    await f.communications.tick(now + 5 * 3600000);
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(1);
  });
  it('sends per recipient, retains stable Message-ID on retry and honours unsubscribe on retry', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    await f.contact(null, 'second@example.com');
    await campaign(f, now);
    await f.communications.tick(now);
    f.sender.mockRejectedValueOnce(new Error('Synthetic SMTP acceptance unknown'));
    await f.queue.drain(now);
    await f.queue.drain(now + 120000);
    expect(f.sender.mock.calls).toHaveLength(3);
    expect(f.sender.mock.calls[0][1].messageId).toBe(f.sender.mock.calls[2][1].messageId);
    expect(f.sender.mock.calls.every(([, msg]) => !msg.to.includes(','))).toBe(true);
    await campaign(f, now + 150000);
    await f.communications.tick(now + 150000);
    f.store.run("UPDATE addresses SET unsubscribed=1 WHERE email='viewer@example.com'");
    await f.queue.drain(now + 150000);
    expect(f.sender).toHaveBeenCalledTimes(4);
  });
  it('keeps batches bounded and does not overlap queue drains', async () => {
    const f = fixture(),
      now = Date.now();
    f.communications.configure({ ...f.communications.settings(), batchSize: 1 });
    await f.contact();
    await f.contact(null, 'second@example.com');
    await campaign(f, now);
    await f.communications.tick(now);
    let release!: () => void;
    f.sender.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const draining = f.queue.drain(now);
    await vi.waitFor(() => expect(f.sender).toHaveBeenCalledTimes(1));
    await f.queue.drain(now);
    release();
    await draining;
    expect(f.sender).toHaveBeenCalledTimes(1);
    await f.queue.drain(now);
    expect(f.sender).toHaveBeenCalledTimes(2);
  });
  it('cancels remaining queued deliveries honestly after partial SMTP acceptance', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    await f.contact(null, 'second@example.com');
    f.communications.configure({ ...f.communications.settings(), batchSize: 1 });
    const row = await campaign(f, now);
    await f.communications.tick(now);
    await f.queue.drain(now);
    expect(f.sender).toHaveBeenCalledTimes(1);
    f.communications.action(row.id, 'cancel', false, true, now + 1);
    await f.queue.drain(now + 2);
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.store.all("SELECT * FROM deliveries WHERE status='superseded'")).toHaveLength(1);
    expect(f.store.all("SELECT * FROM deliveries WHERE status='sent'")).toHaveLength(1);
  });
  it('does not resurrect a cancellation while Plex eligibility is being checked', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    const row = await campaign(f, now);
    await f.communications.tick(now);
    const users = structuredClone(f.plex.shares.synthetic);
    let release!: () => void;
    vi.spyOn(f.plex, 'users').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(users);
        }),
    );
    const drain = f.queue.drain(now);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.communications.action(row.id, 'cancel', false, true, now + 1);
    release();
    await drain;
    expect(f.sender).not.toHaveBeenCalled();
    expect(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status).toBe(
      'superseded',
    );
  });
});

describe('maintenance event lifecycle', () => {
  it('resumes one ongoing outage after suppression ends and never repeats an accepted alert', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    f.store.set('monitor', {
      ...effectiveMonitorSettings(f.store),
      maintenance: [
        { start: new Date(now).toISOString(), end: new Date(now + 60000).toISOString() },
      ],
    });
    const monitor = new Monitor(f.store);
    for (const at of [now, now + 5000, now + 10000, now + 15000]) monitor.observe(false, at);
    await f.queue.drain(now + 15000);
    expect(f.sender).not.toHaveBeenCalled();
    monitor.observe(false, now + 60000);
    await f.queue.drain(now + 60000);
    expect(f.sender).toHaveBeenCalledTimes(1);
    monitor.observe(false, now + 65000);
    await f.queue.drain(now + 65000);
    expect(f.sender).toHaveBeenCalledTimes(1);
    monitor.observe(true, now + 70000);
    monitor.observe(true, now + 75000);
    await f.queue.drain(now + 75000);
    expect(f.sender).toHaveBeenCalledTimes(2);
    expect(f.store.all('SELECT * FROM incidents')).toHaveLength(1);
  });
  const event = (now: number, overrides = {}) => ({
    type: 'maintenance',
    title: 'Sample maintenance',
    explanation: 'Synthetic upgrade.',
    subject: '{{title}}: {{change}}',
    body: '{{server}}: {{explanation}} {{start}} to {{end}} (UTC). {{change}}',
    start: new Date(now + 3600000).toISOString(),
    end: new Date(now + 7200000).toISOString(),
    leads: [3600, 600],
    ...overrides,
  });
  it('uses the same event windows for suppression, including overlaps and explicit completion', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    const first = await campaign(f, now, event(now));
    await campaign(
      f,
      now,
      event(now, { title: 'Overlapping maintenance', end: new Date(now + 10800000).toISOString() }),
    );
    expect(effectiveMonitorSettings(f.store).maintenance).toHaveLength(2);
    const monitor = new Monitor(f.store);
    for (const at of [now + 3600000, now + 3605000, now + 3610000, now + 3615000])
      monitor.observe(false, at);
    expect(
      f.store
        .all<Delivery>("SELECT * FROM deliveries WHERE kind='outage'")
        .every((d) => d.status === 'suppressed'),
    ).toBe(true);
    f.communications.action(first.id, 'complete', true, true, now + 3620000);
    expect(effectiveMonitorSettings(f.store).maintenance).toHaveLength(1);
    await f.communications.tick(now + 3620000);
    await f.queue.drain(now + 3620000);
    expect(f.sender.mock.calls.some(([, msg]) => msg.text.includes('completed explicitly'))).toBe(
      true,
    );
    expect(monitor.state().state).not.toBe('recovered');
  });
  it('supersedes old notices after extension and sends an explicit update without claiming recovery', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    const row = await campaign(f, now, event(now));
    await f.communications.tick(now);
    f.communications.save(
      row.id,
      {
        ...f.draft,
        ...event(now, { end: new Date(now + 10800000).toISOString(), notifyChange: true }),
      },
      now + 1000,
    );
    await f.communications.tick(now + 31000);
    await f.queue.drain(now + 31000);
    expect(
      f.store.all<Delivery>("SELECT * FROM deliveries WHERE status='superseded'"),
    ).toHaveLength(1);
    expect(
      f.sender.mock.calls.some(([, msg]) => msg.text.includes('rescheduled or extended')),
    ).toBe(true);
    expect(effectiveMonitorSettings(f.store).maintenance[0].end).toBe(
      new Date(now + 10800000).toISOString(),
    );
    expect(f.sender.mock.calls.every(([, msg]) => !msg.subject.includes('recovered'))).toBe(true);
  });
  it('does not send old notices in a burst after restart or auto-complete at the planned end', async () => {
    const f = fixture(),
      now = Date.now();
    await f.contact();
    await campaign(f, now, event(now, { leads: [3600, 1800, 600] }));
    f.communications.restart();
    await f.communications.tick(now + 3300000);
    await f.queue.drain(now + 3300000);
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.store.all("SELECT * FROM communication_jobs WHERE status='superseded'")).toHaveLength(
      2,
    );
    await f.communications.tick(now + 7200000);
    expect(f.store.one<{ status: string }>('SELECT status FROM campaigns')?.status).toBe(
      'dispatched',
    );
    expect(f.sender).toHaveBeenCalledTimes(1);
  });
  it('allows suppression-only maintenance with no recipients and cancellation without a notice', async () => {
    const f = fixture(),
      now = Date.now();
    const row = await campaign(f, now, event(now, { leads: [] }));
    expect(effectiveMonitorSettings(f.store).maintenance).toHaveLength(1);
    f.communications.action(row.id, 'cancel', false, true, now + 1);
    await f.communications.tick(now + 2);
    expect(effectiveMonitorSettings(f.store).maintenance).toHaveLength(0);
    expect(f.store.all('SELECT * FROM deliveries')).toHaveLength(0);
  });
  it('rejects invalid schedules, duplicate leads, unsafe links and header/template injection', () => {
    const f = fixture(),
      now = Date.now();
    for (const overrides of [
      { end: new Date(now).toISOString() },
      { leads: [600, 600] },
      { subject: '{{unknown}}' },
      { subject: 'Hello\r\nBcc: injected@example.com' },
    ])
      expect(() =>
        f.communications.save(undefined, { ...f.draft, ...event(now, overrides) }),
      ).toThrow();
    for (const renewalUrl of [
      'http://request.example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://private.lan',
      'https://plex-admin.example.com/path',
      'https://plex-admin.example.com:8443/path',
      'https://request.example.com/?token=synthetic',
    ])
      expect(() =>
        f.communications.configure({
          ...f.communications.settings(),
          expiry: { ...f.communications.settings().expiry, renewalUrl },
        }),
      ).toThrow();
  });
});
