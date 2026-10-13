import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { memory, MockPlex, monitorSettings } from './helpers.js';
import { serializeFilters, filtersMatch } from '../server/filters.js';
import { Plex, type PlexAdapter } from '../server/plex.js';

async function fixture(injected?: PlexAdapter) {
  const store = memory(),
    plex = new MockPlex(),
    bootstrap = randomBytes(32).toString('hex'),
    config = loadConfig({ ENCRYPTION_KEY: store.key, BOOTSTRAP_SECRET: bootstrap });
  const services = createApp(store, config, injected ?? plex),
    agent = request.agent(services.app);
  const response = await agent
    .post('/api/setup')
    .set('Origin', config.url)
    .send({ bootstrap, username: 'administrator', password: 'synthetic-password' });
  const write = (method: 'post' | 'put' | 'delete', path: string, body: unknown) =>
    agent[method](path)
      .set('Origin', config.url)
      .set('X-CSRF-Token', response.body.csrf)
      .send(body as object);
  return { store, plex, agent, write, ...services };
}
describe('authorised integration routes', () => {
  it('loads the authenticated Users API through real adapter parsing of synthetic account responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/servers/synthetic')
        return new Response(
          '<MediaContainer size="3"><Server machineIdentifier="synthetic"><Section id="1" key="10" title="Sample Films" type="movie"/><Section id="2" key="20" title="Sample Shows" type="show"/><Section id="3" key="30" title="Sample Music" type="artist"/></Server></MediaContainer>',
        );
      if (path === '/api/users/')
        return new Response(
          '<MediaContainer size="1"><User id="11" username="sample-viewer"><Server id="101" machineIdentifier="synthetic"/><Server id="202" machineIdentifier="other-server"/></User></MediaContainer>',
        );
      if (path === '/api/invites/requested') return new Response('<MediaContainer size="0"/>');
      if (path === '/api/servers/synthetic/shared_servers/101')
        return new Response(
          '<MediaContainer size="1"><SharedServer id="101" accessToken="synthetic-share-token"><Section id="1" shared="1"/><Section id="2" shared="1"/><Section id="3" shared="0"/></SharedServer></MediaContainer>',
        );
      if (path === '/api/v2/user') return Response.json({ subscription: { active: false } });
      throw new Error('Unexpected synthetic request.');
    });
    const f = await fixture(new Plex('synthetic-account-token', 'test-client', fetcher));
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample server',
        url: 'http://localhost:32400',
        token: 'synthetic-server-token',
      });
      await request(f.app).get('/api/users').expect(401);
      expect(fetcher).not.toHaveBeenCalled();
      const response = await f.agent.get('/api/users').expect(200).expect('Content-Type', /json/);
      expect(response.body.libraries.map((library: { id: string }) => library.id)).toEqual([
        '1',
        '2',
        '3',
      ]);
      expect(response.body.users).toMatchObject([
        { id: '11', shareId: '101', libraries: ['1', '2'], kind: 'shared' },
      ]);
      expect(response.body.capabilities.plexPass).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain('synthetic-share-token');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-account-token');
      expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    } finally {
      f.store.close();
    }
  });
  it('allows reconnecting the same server while retaining its active incident', async () => {
    const f = await fixture();
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample',
        url: 'http://localhost:32400',
        token: 'synthetic-token',
      });
      f.store.set('monitor', monitorSettings());
      for (const at of [0, 5000, 10000, 15000]) f.monitor.observe(false, at);
      const incident = f.monitor.state().incident;
      expect(incident).toBeDefined();
      await f.write('post', '/api/plex/disconnect', { confirm: true }).expect(200);
      expect(f.monitor.state().unknown).toBe(true);
      await f
        .write('post', '/api/plex/server', { id: 'synthetic', url: 'http://localhost:32400' })
        .expect(200);
      expect(f.monitor.state().incident).toBe(incident);
      f.monitor.observe(true, 20000);
      f.monitor.observe(true, 25000);
      expect(f.monitor.state().state).toBe('recovered');
    } finally {
      f.store.close();
    }
  });
  it('rejects expiry on a pending invitation whose account identity is not stable', async () => {
    const f = await fixture();
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample',
        url: 'http://localhost:32400',
        token: 'synthetic-token',
      });
      f.plex.shares.synthetic[0].kind = 'pending';
      await f
        .write('put', '/api/users/11/metadata', {
          notes: 'Synthetic note',
          expires: '2030-01-01T00:00:00.000Z',
        })
        .expect(409);
      expect(f.store.all('SELECT * FROM expiries')).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });
  it('does not re-arm completed expiry when only notes change', async () => {
    const f = await fixture();
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample',
        url: 'http://localhost:32400',
        token: 'synthetic-token',
      });
      f.store.run(
        "INSERT INTO expiries(server,user,due,status) VALUES('synthetic','11',60000,'done')",
      );
      await f
        .write('put', '/api/users/11/metadata', {
          notes: 'Synthetic note',
          expires: '1970-01-01T00:01:00.000Z',
        })
        .expect(200);
      expect(f.store.one<{ status: string }>('SELECT status FROM expiries')?.status).toBe('done');
      await f
        .write('put', '/api/users/11/metadata', {
          notes: 'Synthetic note',
          expires: '2030-01-01T00:00:00.000Z',
        })
        .expect(200);
      expect(f.store.one<{ status: string }>('SELECT status FROM expiries')?.status).toBe(
        'pending',
      );
    } finally {
      f.store.close();
    }
  });
  it('rejects selecting an unowned server and returns no Plex token to the browser', async () => {
    const f = await fixture();
    try {
      const servers = await f.agent.get('/api/plex/servers').expect(200);
      expect(JSON.stringify(servers.body)).not.toContain('synthetic-test-token');
      await f
        .write('post', '/api/plex/server', { id: 'other', url: 'http://localhost:32400' })
        .expect(403);
      await f
        .write('post', '/api/plex/server', { id: 'synthetic', url: 'http://localhost:32400' })
        .expect(200);
      const settings = await f.agent.get('/api/settings');
      expect(settings.body.server.id).toBe('synthetic');
      expect(JSON.stringify(settings.body)).not.toContain('synthetic-test-token');
    } finally {
      f.store.close();
    }
  });
  it('requires destructive confirmation and enforces subscription-aware restrictions', async () => {
    const f = await fixture();
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample',
        url: 'http://localhost:32400',
        token: 'synthetic-token',
      });
      await f.write('delete', '/api/users/11/access', { shareId: '101' }).expect(400);
      expect(f.plex.calls).toHaveLength(0);
      const values = {
        movies: { ratings: ['G'], labels: [] },
        television: { ratings: [], labels: [] },
        music: { labels: [] },
      };
      const expectedFilters = { filterMovies: '', filterTelevision: '', filterMusic: '' };
      await f
        .write('post', '/api/users/11/restrictions', { values, confirmAccountScope: false })
        .expect(400);
      f.plex.pass = false;
      await f
        .write('post', '/api/users/11/restrictions', {
          values,
          expectedFilters,
          confirmAccountScope: true,
        })
        .expect(403);
      f.plex.pass = true;
      await f
        .write('post', '/api/users/11/restrictions', {
          values,
          expectedFilters,
          confirmAccountScope: true,
        })
        .expect(502); // Mock does not confirm filter change.
      await f
        .write('delete', '/api/users/11/access', { shareId: '101', confirm: true })
        .expect(200);
      expect(f.plex.shares.other).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });
  it('masks SMTP and heartbeat secrets and validates external authority pairing', async () => {
    const f = await fixture();
    try {
      await f
        .write('put', '/api/smtp', {
          host: 'smtp.example.com',
          port: 587,
          tls: 'starttls',
          username: 'synthetic',
          password: 'synthetic-password',
          from: 'alerts@example.com',
        })
        .expect(200);
      await f
        .write('put', '/api/heartbeat', {
          url: 'https://monitor.example.com/heartbeat',
          key: randomBytes(32).toString('hex'),
        })
        .expect(200);
      const s = await f.agent.get('/api/settings');
      expect(s.body.smtp.password).toBe('');
      expect(s.body.heartbeat.key).toBe('');
      await f.write('put', '/api/monitor', monitorSettings({ authority: 'external' })).expect(409);
      f.store.set('heartbeat.delivery', { at: Date.now(), ok: true });
      await f.write('put', '/api/monitor', monitorSettings({ authority: 'external' })).expect(200);
    } finally {
      f.store.close();
    }
  });
  it('compares restriction results semantically rather than assuming 2xx succeeded', () => {
    const expected = serializeFilters({
      movies: { ratings: ['G', 'PG'], labels: ['Sample'] },
      television: { ratings: [], labels: [] },
      music: { labels: [] },
    });
    expect(
      filtersMatch({ ...expected, filterMovies: 'label=Sample|contentRating=PG%2CG' }, expected),
    ).toBe(true);
    expect(filtersMatch({ ...expected, filterMovies: '' }, expected)).toBe(false);
  });
  it('rejects a restriction preview that became stale before mutation', async () => {
    const f = await fixture();
    try {
      f.store.setSecret('server', {
        id: 'synthetic',
        name: 'Sample',
        url: 'http://localhost:32400',
        token: 'synthetic-token',
      });
      f.plex.shares.synthetic[0].filters = { filterMovies: 'contentRating=PG' };
      const mutation = vi.spyOn(f.plex, 'restrictions');
      await f
        .write('post', '/api/users/11/restrictions', {
          confirmAccountScope: true,
          expectedFilters: { filterMovies: '', filterTelevision: '', filterMusic: '' },
          values: {
            movies: { ratings: ['G'], labels: [] },
            television: { ratings: [], labels: [] },
            music: { labels: [] },
          },
        })
        .expect(409);
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      f.store.close();
    }
  });
});
