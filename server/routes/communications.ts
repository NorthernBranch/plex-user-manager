import { Router } from 'express';
import { z } from 'zod';
import { preferencesSchema } from '../communications-config.js';
import type { Contacts } from '../contacts.js';
import type { AppServices } from './context.js';

export function registerRecipientRoutes(router: Router, contacts: Contacts) {
  const requests = new Map<string, { count: number; until: number }>();
  router.use((req, res, next) => {
    const now = Date.now();
    for (const [key, entry] of requests) if (entry.until < now) requests.delete(key);
    const key = req.ip ?? 'unknown',
      entry = requests.get(key) ?? { count: 0, until: now + 60000 };
    entry.count++;
    requests.set(key, entry);
    if (entry.count > 60 || requests.size > 10000)
      return res.status(429).json({ error: 'Too many link requests. Try again later.' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/{*path}', (_req, res) =>
    res.status(405).json({ error: 'Link actions require explicit confirmation using POST.' }),
  );
  const token = z.string().regex(/^[a-f0-9]{64}$/);
  router.post('/view', (req, res) =>
    res.json(contacts.view(z.object({ token }).parse(req.body).token)),
  );
  router.post('/verify', (req, res) => {
    const body = z.object({ token, confirm: z.literal(true) }).parse(req.body);
    res.json(contacts.verify(body.token, body.confirm));
  });
  router.post('/preferences', (req, res) => {
    const body = z
      .object({
        token,
        confirm: z.literal(true),
        preferences: preferencesSchema,
        unsubscribed: z.boolean(),
      })
      .parse(req.body);
    res.json(contacts.preferences(body.token, body.preferences, body.unsubscribed, body.confirm));
  });
}
export function registerCommunicationRoutes({
  app,
  store,
  contacts,
  communications,
  email,
}: AppServices) {
  app.get('/api/contacts', (_req, res) => res.json(contacts.list()));
  app.post('/api/contacts', async (req, res) => res.json(await contacts.save(undefined, req.body)));
  app.put('/api/contacts/:id', async (req, res) =>
    res.json(await contacts.save(String(req.params.id), req.body)),
  );
  app.post('/api/contacts/:id/links', (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    res.json(contacts.issue(String(req.params.id)));
  });
  app.get('/api/communications', (_req, res) => res.json(communications.list()));
  app.put('/api/communications/settings', (req, res) =>
    res.json(communications.configure(req.body)),
  );
  app.post('/api/communications/drafts', (req, res) =>
    res.json(communications.save(undefined, req.body)),
  );
  app.put('/api/communications/drafts/:id', (req, res) =>
    res.json(communications.save(String(req.params.id), req.body)),
  );
  app.delete('/api/communications/drafts/:id', (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    communications.remove(String(req.params.id));
    res.json({ ok: true });
  });
  app.post('/api/communications/drafts/:id/preview', async (req, res) =>
    res.json(await communications.preview(String(req.params.id))),
  );
  app.post('/api/communications/drafts/:id/confirm', (req, res) => {
    const b = z
      .object({
        ticket: z.uuid(),
        scheduled: z.iso.datetime().nullable(),
        confirm: z.literal(true),
      })
      .parse(req.body);
    res.json(
      communications.confirm(
        String(req.params.id),
        b.ticket,
        b.scheduled ? Date.parse(b.scheduled) : null,
        b.confirm,
      ),
    );
  });
  app.post('/api/communications/drafts/:id/test', (req, res) => {
    const b = z.object({ recipient: z.email(), confirm: z.literal(true) }).parse(req.body);
    res.json({
      id: communications.testCampaign(String(req.params.id), b.recipient),
      status: 'queued',
    });
  });
  app.post('/api/communications/events/:id/action', (req, res) => {
    const b = z
      .object({
        action: z.enum(['cancel', 'complete']),
        notify: z.boolean(),
        confirm: z.literal(true),
      })
      .parse(req.body);
    res.json(communications.action(String(req.params.id), b.action, b.notify, b.confirm));
  });
  app.post('/api/communications/jobs/:id/retry', (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    communications.retryJob(String(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/communications/maintenance-export', (_req, res) =>
    res.json(communications.exportMaintenance()),
  );
  app.post('/api/users/:id/welcome/preview', async (req, res) =>
    res.json(await communications.welcomePreview(String(req.params.id))),
  );
  app.post('/api/users/:id/welcome', async (req, res) => {
    const b = z.object({ requestId: z.uuid(), confirm: z.literal(true) }).parse(req.body);
    res.json(await communications.welcome(String(req.params.id), b.requestId, b.confirm));
  });
  app.post('/api/users/:id/welcome/test', async (req, res) => {
    const b = z.object({ recipient: z.email(), confirm: z.literal(true) }).parse(req.body);
    res.json({
      id: email.enqueue({
        key: crypto.randomUUID(),
        kind: 'test',
        recipient: b.recipient,
        ...(await communications.welcomePreview(String(req.params.id))),
      }),
      status: 'queued',
    });
  });
  app.get('/api/communications/history', (_req, res) =>
    res.json(
      store.all(
        'SELECT id,incident,kind,recipient,status,attempts,error,sent,next FROM deliveries ORDER BY id DESC LIMIT 500',
      ),
    ),
  );
}
