import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { restrictionsSchema } from '../plex.js';
import { AppError } from '../errors.js';
import { filtersMatch, serializeFilters } from '../filters.js';
import type { AppServices } from './context.js';
const libraryIds = z
  .array(z.string().min(1).max(80))
  .max(200)
  .refine((v) => new Set(v).size === v.length);
export function registerAccessRoutes({
  app,
  store,
  client,
  selected,
  access,
  contacts,
  communications,
}: AppServices) {
  app.get('/api/users', async (_req, res) => {
    const snapshot = await access.snapshot();
    communications.observe(snapshot.server, snapshot.users);
    const meta = store.all<{ user: string; notes: string }>(
      'SELECT user,notes FROM metadata WHERE server=?',
      snapshot.server,
    );
    res.json({
      ...snapshot,
      users: snapshot.users.map((user) => ({
        ...user,
        contact:
          contacts.list().find((c) => c.server === snapshot.server && c.user === user.id) ?? null,
        notes: meta.find((m) => m.user === user.id)?.notes ?? '',
        expiry:
          store.one(
            "SELECT due,status,error,revision FROM expiries WHERE server=? AND user=? AND status<>'cancelled'",
            snapshot.server,
            user.id,
          ) ?? null,
      })),
      capabilities: {
        plexPass: (await client().account()).plexPass,
        managedCreation: false,
        restrictionScope:
          'Account sharing settings across servers; managed-user restrictions must be edited in Plex Web.',
      },
    });
  });
  app.post('/api/invitations', async (req, res) => {
    const body = z
      .object({ identity: z.string().min(1).max(254), libraries: libraryIds })
      .parse(req.body);
    await access.exclusive(() => access.invite(body.identity, body.libraries));
    res.json({
      accepted: true,
      verified: false,
      message:
        'Plex accepted the invitation request. Refresh and check pending invitations; acceptance by the recipient remains pending.',
    });
  });
  app.put('/api/users/:id/access', async (req, res) => {
    const body = z.object({ libraries: libraryIds, shareId: z.string() }).parse(req.body);
    res.json(
      await access.exclusive(() =>
        access.change(String(req.params.id), body.libraries, body.shareId),
      ),
    );
  });
  app.delete('/api/users/:id/access', async (req, res) => {
    const body = z.object({ confirm: z.literal(true), shareId: z.string() }).parse(req.body);
    res.json(
      await access.exclusive(() => access.change(String(req.params.id), null, body.shareId)),
    );
  });
  app.put('/api/users/:id/metadata', async (req, res) =>
    access.exclusive(async () => {
      const body = z
          .object({ notes: z.string().max(10000), expires: z.iso.datetime().nullable() })
          .parse(req.body),
        server = selected().id,
        user = String(req.params.id);
      if (body.expires) {
        const current = (await client().users(server)).find((account) => account.id === user);
        if (!current) throw new AppError(404, 'USER', 'Refresh the user before scheduling expiry.');
        if (current.kind === 'pending')
          throw new AppError(
            409,
            'PENDING_EXPIRY',
            'Set access expiry after the invitation is accepted. Pending invitation identifiers may change.',
          );
      }
      store.transaction(() => {
        store.run(
          'INSERT INTO metadata(server,user,notes) VALUES(?,?,?) ON CONFLICT(server,user) DO UPDATE SET notes=excluded.notes',
          server,
          user,
          body.notes,
        );
        const existing = store.one<{ due: number; status: string }>(
          'SELECT due,status FROM expiries WHERE server=? AND user=?',
          server,
          user,
        );
        if (
          body.expires &&
          (existing?.due !== Date.parse(body.expires) || existing?.status === 'cancelled')
        )
          store.run(
            "INSERT INTO expiries(server,user,due,status) VALUES(?,?,?,'pending') ON CONFLICT(server,user) DO UPDATE SET due=excluded.due,status='pending',attempts=0,next=0,error=NULL,revision=expiries.revision+1",
            server,
            user,
            Date.parse(body.expires),
          );
        else if (!body.expires)
          store.run(
            "UPDATE expiries SET status='cancelled',revision=revision+1,error=NULL WHERE server=? AND user=? AND status<>'cancelled'",
            server,
            user,
          );
        store.audit('metadata.update', user, 'notes and expiry saved');
        if (
          !body.expires ||
          existing?.due !== Date.parse(body.expires) ||
          existing?.status === 'cancelled'
        )
          communications.invalidateExpiry(server, user);
      });
      res.json({ ok: true });
    }),
  );
  app.post('/api/users/:id/restrictions', async (req, res) => {
    const body = z
      .object({
        confirmAccountScope: z.literal(true),
        values: restrictionsSchema,
        expectedFilters: z.object({
          filterMovies: z.string().max(10000),
          filterTelevision: z.string().max(10000),
          filterMusic: z.string().max(10000),
        }),
      })
      .parse(req.body);
    await access.exclusive(async () => {
      const adapter = client(),
        user = (await adapter.users(selected().id)).find((u) => u.id === req.params.id);
      if (!user || user.kind !== 'shared')
        throw new AppError(
          409,
          'UNSUPPORTED',
          'Restrictions for managed users and pending invitations must be configured in Plex Web.',
        );
      if (!(await adapter.account()).plexPass)
        throw new AppError(
          403,
          'PLEX_PASS',
          'Content restrictions require Plex Pass on the owner account.',
        );
      if (!filtersMatch(user.filters, body.expectedFilters))
        throw new AppError(
          409,
          'CHANGED',
          'Content filters changed since this editor opened. Refresh and preview again.',
        );
      await adapter.restrictions(user.id, body.values);
      const after = (await adapter.users(selected().id)).find((u) => u.id === user.id);
      if (!after || !filtersMatch(after.filters, serializeFilters(body.values)))
        throw new AppError(
          502,
          'RECONCILE',
          'Plex has not confirmed the requested content filters. Refresh and inspect Plex Web before retrying.',
        );
      store.audit('restrictions.update', user.id, 'Plex accepted; account filters refreshed');
      res.json({
        accepted: true,
        filters: after.filters,
        message:
          'Inspect refreshed filters. Settings apply to this account across your server shares.',
      });
    });
  });
  app.post('/api/bulk/preview', async (req, res) => {
    const body = z
      .object({
        users: z
          .array(z.string())
          .min(1)
          .max(100)
          .refine((v) => new Set(v).size === v.length),
        libraries: libraryIds,
      })
      .parse(req.body);
    res.json(await access.exclusive(() => access.preview(body.users, body.libraries)));
  });
  app.post('/api/bulk/apply', async (req, res) => {
    const body = z.object({ ticket: z.uuid(), confirm: z.literal(true) }).parse(req.body);
    res.json(await access.exclusive(() => access.apply(body.ticket)));
  });
  app.get('/api/presets', (_req, res) =>
    res.json(
      store
        .all('SELECT * FROM presets WHERE server=?', selected().id)
        .map((row: any) => ({ ...row, libraries: JSON.parse(row.libraries) })),
    ),
  );
  app.post('/api/presets', async (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(80), libraries: libraryIds })
      .parse(req.body);
    await access.validateLibraries(body.libraries);
    store.run(
      'INSERT INTO presets VALUES(?,?,?,?)',
      randomUUID(),
      selected().id,
      body.name,
      JSON.stringify(body.libraries),
    );
    store.audit('preset.create', body.name, 'saved');
    res.json({ ok: true });
  });
  app.delete('/api/presets/:id', (req, res) => {
    store.run('DELETE FROM presets WHERE id=? AND server=?', String(req.params.id), selected().id);
    res.json({ ok: true });
  });
}
