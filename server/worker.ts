import express from 'express';
import helmet from 'helmet';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { secret, monitorSchema, smtpSchema } from './config.js';
import { Store } from './store.js';
import { Monitor } from './monitor.js';
import { EmailQueue } from './email.js';
import { acceptHeartbeat, heartbeatAcknowledgement } from './heartbeat.js';
import { ExternalMonitor } from './external-monitor.js';

try {
  const key = secret(process.env, 'ENCRYPTION_KEY'),
    heartbeatKey = secret(process.env, 'HEARTBEAT_KEY');
  if (!/^[a-f0-9]{64}$/i.test(key) || heartbeatKey.length < 32) throw new Error('Invalid secrets');
  const config = z
    .object({
      monitor: monitorSchema,
      smtp: smtpSchema,
      heartbeatGraceSeconds: z.number().int().min(30).max(600),
    })
    .parse(
      JSON.parse(
        readFileSync(process.env.WORKER_CONFIG_FILE ?? '/run/secrets/worker_config', 'utf8'),
      ),
    );
  const store = new Store(join(process.env.DATA_DIR ?? './data', 'worker.db'), key);
  store.set('monitor', { ...config.monitor, authority: 'local' });
  store.setSecret('smtp', config.smtp);
  const monitor = new Monitor(
      store,
      'External heartbeat: local Plex identity result and monitored host/network liveness; does not prove remote playback.',
      false,
    ),
    email = new EmailQueue(store);
  monitor.restart();
  email.restart();
  const external = new ExternalMonitor(store, monitor, config.heartbeatGraceSeconds);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  // No administrative UI or Plex credentials. Only this signed, size-limited heartbeat endpoint is exposed.
  const attempts = new Map<string, { count: number; at: number }>();
  app.post('/heartbeat', express.text({ type: 'application/json', limit: '2kb' }), (req, res) => {
    const now = Date.now();
    for (const [key, entry] of attempts) if (now - entry.at > 60000) attempts.delete(key);
    const ip = req.ip ?? 'unknown',
      entry = attempts.get(ip) ?? { count: 0, at: now };
    entry.count++;
    attempts.set(ip, entry);
    if (entry.count > 120 || attempts.size > 10000) return res.sendStatus(429);
    try {
      if (!acceptHeartbeat(store, req.body, req.get('x-heartbeat-signature') ?? '', heartbeatKey))
        return res.sendStatus(403);
      const nonce = z.object({ nonce: z.uuid() }).parse(JSON.parse(req.body)).nonce;
      res.set(heartbeatAcknowledgement(store, nonce, heartbeatKey));
      res.sendStatus(204);
    } catch {
      res.sendStatus(400);
    }
  });
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT ?? 3000);
  const server = app.listen(port, '0.0.0.0', () =>
    process.stdout.write('External monitoring worker is ready.\n'),
  );
  const timer = setInterval(() => {
    try {
      external.tick();
    } catch {
      store.audit('monitor.worker', 'scheduler', 'worker unavailable');
    }
  }, config.monitor.intervalSeconds * 1000);
  const emailTimer = setInterval(
    () =>
      void email.drain().catch(() => store.audit('email.worker', 'queue', 'worker unavailable')),
    5000,
  );
  function stop() {
    clearInterval(timer);
    clearInterval(emailTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 20000).unref();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch {
  process.stderr.write(
    'Worker startup failed. Check worker config, deployment keys and storage permissions.\n',
  );
  process.exitCode = 1;
}
