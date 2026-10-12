import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { memory, MockPlex } from './helpers.js';
import { type Store } from '../server/store.js';

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
function fixture(publicUrl = 'http://localhost:3000') {
  const store = memory();
  stores.push(store);
  const bootstrap = randomBytes(32).toString('hex');
  const config = loadConfig({
    PUBLIC_URL: publicUrl,
    ENCRYPTION_KEY: store.key,
    BOOTSTRAP_SECRET: bootstrap,
  });
  return { store, bootstrap, ...createApp(store, config, new MockPlex()) };
}
describe('administrator boundary', () => {
  it('requires bootstrap protection and rejects reclaiming setup', async () => {
    const f = fixture(),
      agent = request.agent(f.app);
    await agent
      .post('/api/setup')
      .set('Origin', 'http://localhost:3000')
      .send({ username: 'administrator', password: 'synthetic-password', bootstrap: 'wrong' })
      .expect(403);
    const setup = await agent
      .post('/api/setup')
      .set('Origin', 'http://localhost:3000')
      .send({ username: 'administrator', password: 'synthetic-password', bootstrap: f.bootstrap })
      .expect(200);
    expect(setup.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(setup.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    await agent
      .post('/api/setup')
      .set('Origin', 'http://localhost:3000')
      .send({ username: 'administrator', password: 'synthetic-password', bootstrap: f.bootstrap })
      .expect(409);
  });
  it('protects all admin reads and mutations including Plex authentication', async () => {
    const f = fixture();
    for (const url of [
      '/api/users',
      '/api/monitor',
      '/api/settings',
      '/api/audit',
      '/api/deliveries',
      '/api/plex/servers',
      '/api/presets',
      '/api/contacts',
      '/api/communications',
      '/api/communications/history',
      '/api/communications/maintenance-export',
    ])
      await request(f.app).get(url).expect(401);
    for (const url of [
      '/api/plex/pin',
      '/api/plex/poll',
      '/api/invitations',
      '/api/bulk/apply',
      '/api/smtp/test',
      '/api/password',
      '/api/contacts',
      '/api/communications/drafts',
      '/api/communications/jobs/synthetic/retry',
      '/api/users/11/welcome',
    ])
      await request(f.app).post(url).set('Origin', 'http://localhost:3000').send({}).expect(401);
  });
  it('rejects cross-origin and missing CSRF tokens; expires and revokes sessions', async () => {
    const f = fixture(),
      agent = request.agent(f.app),
      setup = await agent.post('/api/setup').set('Origin', 'http://localhost:3000').send({
        username: 'administrator',
        password: 'synthetic-password',
        bootstrap: f.bootstrap,
      });
    await agent.put('/api/monitor').set('Origin', 'http://localhost:3000').send({}).expect(403);
    for (const url of ['/api/contacts', '/api/communications/drafts', '/api/users/11/welcome'])
      await agent.post(url).set('Origin', 'http://localhost:3000').send({}).expect(403);
    await agent
      .post('/api/logout')
      .set('Origin', 'https://attacker.example.com')
      .set('X-CSRF-Token', setup.body.csrf)
      .send({})
      .expect(403);
    expect((await agent.get('/api/settings')).headers['cache-control']).toBe('no-store');
    await agent
      .post('/api/logout')
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Token', setup.body.csrf)
      .send({})
      .expect(200);
    await agent.get('/api/session').expect(401);
    await agent
      .post('/api/login')
      .set('Origin', 'http://localhost:3000')
      .send({ username: 'administrator', password: 'synthetic-password' })
      .expect(200);
    f.store.run('UPDATE sessions SET expires=0');
    await agent.get('/api/session').expect(401);
  });
  it('does not give Plex identities an application login and rate-limits guesses', async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++)
      await request(f.app)
        .post('/api/login')
        .set('Origin', 'http://localhost:3000')
        .send({ username: 'plex-viewer', password: 'synthetic-password' })
        .expect(401);
    await request(f.app)
      .post('/api/login')
      .set('Origin', 'http://localhost:3000')
      .send({ username: 'plex-viewer', password: 'synthetic-password' })
      .expect(429);
  });
  it('uses secure cookies for public HTTPS', async () => {
    const f = fixture('https://plex-admin.example.com');
    const result = await request(f.app)
      .post('/api/setup')
      .set('Origin', 'https://plex-admin.example.com')
      .send({ username: 'administrator', password: 'synthetic-password', bootstrap: f.bootstrap })
      .expect(200);
    expect(result.headers['set-cookie'][0]).toMatch(/Secure/);
  });
});
