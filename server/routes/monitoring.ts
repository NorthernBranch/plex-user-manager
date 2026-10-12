import { z } from 'zod';
import { monitorSchema, smtpSchema, heartbeatSchema } from '../config.js';
import { AppError } from '../errors.js';
import type { AppServices } from './context.js';
export function registerMonitoringRoutes({ app, store, monitor, email }: AppServices) {
  app.get('/api/monitor', (_req, res) =>
    res.json({
      state: monitor.state(),
      incidents: store.all('SELECT * FROM incidents ORDER BY confirmed DESC LIMIT 100'),
      timeline: store.all('SELECT * FROM timeline ORDER BY at DESC LIMIT 200'),
      expiries: store.all('SELECT * FROM expiries ORDER BY due'),
    }),
  );
  app.put('/api/monitor', (req, res) => {
    const settings = monitorSchema.parse(req.body);
    if (settings.authority !== monitor.settings().authority && monitor.state().incident)
      throw new AppError(
        409,
        'AUTHORITY',
        'Resolve the current incident before changing notification authority.',
      );
    const heartbeat = store.get<{ ok: boolean; at: number }>('heartbeat.delivery');
    if (
      settings.authority === 'external' &&
      (!store.getSecret('heartbeat') ||
        !heartbeat?.ok ||
        Date.now() - heartbeat.at > settings.intervalSeconds * 3000)
    )
      throw new AppError(
        409,
        'HEARTBEAT',
        'Configure the external worker and wait for a successfully accepted heartbeat before making it the alert authority.',
      );
    store.set('monitor', settings);
    monitor.restart();
    store.audit('monitor.configure', 'monitor', 'saved');
    res.json({ ok: true });
  });
  app.put('/api/heartbeat', (req, res) => {
    const input = heartbeatSchema.parse({
      ...req.body,
      key: req.body.key || store.getSecret<{ key: string }>('heartbeat')?.key,
    });
    store.setSecret('heartbeat', input);
    store.set('heartbeat.delivery', { at: 0, ok: false });
    store.audit('heartbeat.configure', 'worker', 'saved');
    res.json({ ok: true });
  });
  app.put('/api/smtp', (req, res) => {
    const input = smtpSchema.parse({
      ...req.body,
      password: req.body.password || store.getSecret<{ password: string }>('smtp')?.password || '',
    });
    if (input.username && !input.password)
      throw new AppError(400, 'SMTP', 'SMTP authentication requires a password.');
    store.setSecret('smtp', input);
    store.audit('smtp.configure', 'smtp', 'saved');
    res.json({ ok: true });
  });
  app.post('/api/smtp/test', (req, res) => {
    const body = z.object({ recipient: z.email() }).parse(req.body);
    if (!store.getSecret('smtp')) throw new AppError(409, 'SMTP', 'Configure SMTP first.');
    res.json({ id: email.test(body.recipient), status: 'queued' });
  });
  app.get('/api/deliveries', (_req, res) =>
    res.json(
      store.all(
        'SELECT id,incident,kind,recipient,status,attempts,error,sent,next FROM deliveries ORDER BY id DESC LIMIT 300',
      ),
    ),
  );
  app.post('/api/deliveries/:id/retry', (req, res) => {
    email.retry(z.coerce.number().int().parse(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/audit', (_req, res) =>
    res.json(store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 300')),
  );
}
