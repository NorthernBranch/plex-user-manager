import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Plex, type SelectedServer, validServerUrl } from '../plex.js';
import type { SmtpSettings } from '../config.js';
import { AppError } from '../errors.js';
import type { AppServices } from './context.js';
export function registerIntegrationRoutes({
  app,
  store,
  config,
  client,
  selected,
  access,
  monitor,
}: AppServices) {
  app.get('/api/settings', (_req, res) => {
    const server = store.getSecret<SelectedServer>('server'),
      smtp = store.getSecret<SmtpSettings>('smtp'),
      heartbeat = store.getSecret<{ url: string; key: string }>('heartbeat');
    res.json({
      publicUrl: config.url,
      plexConnected: !!store.getSecret('plex'),
      server: server ? { id: server.id, name: server.name, url: server.url } : null,
      monitor: monitor.settings(),
      smtp: smtp ? { ...smtp, password: '', hasPassword: !!smtp.password } : null,
      heartbeat: heartbeat ? { url: heartbeat.url, key: '', hasKey: true } : null,
      heartbeatDelivery: store.get('heartbeat.delivery') ?? null,
    });
  });
  app.post('/api/plex/pin', async (_req, res) => {
    const plex = new Plex('', randomUUID()),
      pin = await plex.pin();
    store.setSecret('pin', { id: pin.id, clientId: plex.clientId, expires: Date.now() + 600000 });
    res.json({ url: pin.url });
  });
  app.post('/api/plex/poll', async (_req, res) => {
    const pin = store.getSecret<{ id: number; clientId: string; expires: number }>('pin');
    if (!pin || pin.expires < Date.now())
      throw new AppError(409, 'PIN', 'Plex sign-in expired. Start again.');
    const result = await new Plex('', pin.clientId).poll(pin.id);
    if (!result.authToken) return res.json({ connected: false });
    const plex = new Plex(result.authToken, pin.clientId);
    await plex.account();
    const servers = await plex.ownedServers();
    if (!servers.length)
      throw new AppError(403, 'OWNERSHIP', 'This Plex account owns no Media Servers.');
    const previous = store.getSecret<{ token: string; clientId: string }>('plex');
    if (previous && store.getSecret('server'))
      throw new AppError(
        409,
        'RECONNECT',
        'Disconnect the existing integration before connecting another account.',
      );
    store.setSecret('plex', { token: result.authToken, clientId: pin.clientId });
    store.run('DELETE FROM kv WHERE key=?', 'pin');
    store.audit('plex.connect', 'account', 'owned server available');
    res.json({ connected: true });
  });
  app.post('/api/plex/disconnect', async (req, res) =>
    access.exclusive(async () => {
      if (req.body.confirm !== true)
        throw new AppError(400, 'CONFIRM', 'Confirm integration disconnect.');
      const previous = store.getSecret<SelectedServer>('server');
      if (previous) store.set('lastServerId', previous.id);
      store.run("DELETE FROM kv WHERE key IN ('plex','server','pin')");
      monitor.restart();
      store.audit(
        'plex.disconnect',
        'integration',
        'disconnected; expiry jobs paused until server selected',
      );
      res.json({ ok: true });
    }),
  );
  app.get('/api/plex/servers', async (_req, res) =>
    res.json(
      (await client().ownedServers()).map((s) => ({
        id: s.id,
        name: s.name,
        connections: s.connections,
      })),
    ),
  );
  app.post('/api/plex/server', async (req, res) =>
    access.exclusive(async () => {
      const input = z
        .object({
          id: z.string(),
          url: z.string().refine(validServerUrl),
          confirmSwitch: z.boolean().optional(),
        })
        .parse(req.body);
      const old = store.getSecret<SelectedServer>('server');
      if (old && old.id !== input.id && !input.confirmSwitch)
        throw new AppError(
          409,
          'SWITCH',
          'Confirm changing the monitored server. Existing expiry jobs remain scoped to their original server.',
        );
      const server = (await client().ownedServers()).find((s) => s.id === input.id);
      if (!server)
        throw new AppError(
          403,
          'OWNERSHIP',
          'Selected server is not owned by the authenticated account.',
        );
      const selection = { id: server.id, name: server.name, url: input.url, token: server.token };
      await client().probe(selection, 10000);
      if (
        (old?.id ?? store.get<string>('lastServerId')) !== selection.id &&
        monitor.state().incident
      )
        throw new AppError(
          409,
          'INCIDENT',
          'Resolve the current monitoring incident before changing servers.',
        );
      store.setSecret('server', selection);
      store.set('lastServerId', selection.id);
      monitor.restart();
      store.audit('server.select', server.id, 'ownership and identity verified');
      res.json({ ok: true });
    }),
  );
  app.post('/api/plex/test', async (_req, res) => {
    await client().probe(selected(), 10000);
    res.json({
      ok: true,
      scope: 'Selected Plex identity API only; does not prove playback or remote access.',
    });
  });
}
