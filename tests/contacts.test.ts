import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { communicationFixture } from './communication-helpers.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { noPreferences } from '../server/communication-preferences.js';
import { contactReason, notificationRecipients } from '../server/recipients.js';
import { monitorSettings } from './helpers.js';
import type { Delivery } from '../server/email.js';

const fixtures: ReturnType<typeof communicationFixture>[] = [];
const fixture = () => {
  const f = communicationFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => fixtures.splice(0).forEach((f) => f.store.close()));
describe('notification contacts and scoped links', () => {
  it('keeps notification identity separate, never verifies an administrator-entered address', async () => {
    const f = fixture(),
      contact = await f.contact('11', 'viewer@example.com', false);
    expect(contact).toMatchObject({ user: '11', server: 'synthetic', verified: false });
    expect(contactReason(f.store, contact, 'announcement')).toBeTruthy();
    f.plex.shares.synthetic[0].kind = 'pending';
    await expect(
      f.contacts.save(undefined, {
        user: '11',
        email: 'other@example.com',
        active: true,
        preferences: noPreferences,
      }),
    ).rejects.toMatchObject({ code: 'CONTACT' });
    await expect(
      f.contacts.save(contact.id, {
        user: '12',
        email: contact.email,
        active: true,
        preferences: noPreferences,
      }),
    ).rejects.toMatchObject({ code: 'CONTACT' });
  });
  it('stores only hashed tokens and encrypted private queue bodies, and reissues invalidate links', async () => {
    const f = fixture(),
      c = await f.contact('11', 'viewer@example.com', false);
    f.contacts.issue(c.id);
    const token = f.token('verification');
    expect(JSON.stringify(f.store.all('SELECT * FROM contact_tokens'))).not.toContain(token);
    const rows = f.store.all<Delivery>('SELECT * FROM deliveries');
    expect(rows.every((row) => row.body === '' && !row.private_body?.includes(token))).toBe(true);
    expect(f.contacts.view(token)).toMatchObject({ verified: false, scope: 'verify' });
    expect(f.contacts.view(token)).not.toHaveProperty('user');
    f.contacts.issue(c.id);
    expect(() => f.contacts.view(token)).toThrow();
    await f.queue.drain();
    expect(f.sender).toHaveBeenCalledTimes(2);
    expect(
      f.sender.mock.calls.every(
        ([, msg]) => msg.to === c.email && msg.text.includes('/recipient#token='),
      ),
    ).toBe(true);
  });
  it('GET scanners cannot verify or unsubscribe; scoped recipients cannot access admin routes', async () => {
    const f = fixture(),
      c = await f.contact('11', 'viewer@example.com', false);
    f.contacts.issue(c.id);
    const token = f.token('verification');
    const config = loadConfig({
      PUBLIC_URL: 'https://plex-admin.example.com',
      ENCRYPTION_KEY: f.store.key,
      BOOTSTRAP_SECRET: 'b'.repeat(64),
    });
    const { app } = createApp(f.store, config, f.plex);
    await request(app).get('/api/recipient/verify').expect(405);
    await request(app)
      .post('/api/recipient/view')
      .set('Origin', config.url)
      .send({ token })
      .expect(200);
    await request(app)
      .post('/api/recipient/verify')
      .set('Origin', config.url)
      .send({ token })
      .expect(400);
    await request(app)
      .post('/api/recipient/verify')
      .set('Origin', 'https://attacker.example.com')
      .send({ token, confirm: true })
      .expect(403);
    expect(f.contacts.list()[0].verified).toBe(false);
    for (const path of [
      '/api/contacts',
      '/api/communications',
      '/api/communications/history',
      '/api/communications/maintenance-export',
    ])
      await request(app).get(path).expect(401);
    for (const path of ['/api/contacts', '/api/communications/drafts', '/api/users/11/welcome'])
      await request(app).post(path).set('Origin', config.url).send({ token }).expect(401);
  });
  it('verification is single-use, expires and does not alter consent', async () => {
    const f = fixture(),
      c = await f.contact('11', 'viewer@example.com', false);
    await f.contacts.save(c.id, { ...c, preferences: noPreferences });
    const now = Date.now();
    f.contacts.issue(c.id, now);
    const token = f.token('verification');
    expect(() => f.contacts.verify(token, false, now)).toThrow();
    expect(() => f.contacts.view(token, now + 86400000)).toThrow();
    f.contacts.verify(token, true, now + 1);
    expect(f.contacts.list()[0]).toMatchObject({ verified: true, preferences: noPreferences });
    expect(() => f.contacts.verify(token, true, now + 2)).toThrow();
    expect(() =>
      f.contacts.preferences(f.token('verification'), noPreferences, true, true),
    ).toThrow();
  });
  it('email changes require confirmation, invalidate tokens and reset verification', async () => {
    const f = fixture(),
      c = await f.contact();
    f.contacts.issue(c.id);
    const token = f.token('preference-link');
    await expect(
      f.contacts.save(c.id, { ...c, email: 'replacement@example.com' }),
    ).rejects.toMatchObject({ code: 'CONFIRM' });
    const changed = await f.contacts.save(c.id, {
      ...c,
      email: 'replacement@example.com',
      confirmEmailChange: true,
    });
    expect(changed).toMatchObject({ revision: 2, verified: false });
    expect(() => f.contacts.view(token)).toThrow();
    await f.queue.drain();
    expect(f.sender).not.toHaveBeenCalled();
  });
  it('applies shared-address unsubscribe globally and blocks account-specific leakage', async () => {
    const f = fixture(),
      c = await f.contact();
    f.plex.shares.synthetic.push({ ...f.plex.shares.synthetic[0], id: '12', shareId: '102' });
    await f.contact('12');
    await f.contact(null);
    expect(contactReason(f.store, c, 'welcome', true)).toMatch(/shared/i);
    f.contacts.issue(c.id);
    f.contacts.preferences(f.token('preference-link'), noPreferences, true, true);
    expect(
      f.contacts
        .list()
        .every((contact) => contact.unsubscribed && !contact.preferences.announcement),
    ).toBe(true);
    expect(
      notificationRecipients(f.store, monitorSettings({ recipients: [] }), 'synthetic'),
    ).toHaveLength(0);
    const updated = await f.contacts.save(c.id, {
      ...c,
      preferences: { ...noPreferences, outage: true },
    });
    expect(contactReason(f.store, updated, 'outage')).toBeTruthy();
    expect(() => f.contacts.issue(c.id)).toThrow();
  });
  it('redacts link bodies from all history responses', async () => {
    const f = fixture(),
      c = await f.contact('11', 'viewer@example.com', false);
    f.contacts.issue(c.id);
    const config = loadConfig({ ENCRYPTION_KEY: f.store.key, BOOTSTRAP_SECRET: 'b'.repeat(64) });
    const { app } = createApp(f.store, config, f.plex),
      agent = request.agent(app);
    await agent
      .post('/api/setup')
      .set('Origin', config.url)
      .send({
        bootstrap: 'b'.repeat(64),
        username: 'administrator',
        password: 'synthetic-password',
      })
      .expect(200);
    const history = await agent.get('/api/communications/history').expect(200);
    expect(JSON.stringify(history.body)).not.toContain(f.token('verification'));
    expect(
      history.body.every(
        (row: Record<string, unknown>) => !('body' in row) && !('private_body' in row),
      ),
    ).toBe(true);
  });
});
