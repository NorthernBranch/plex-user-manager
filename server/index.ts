import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { inMaintenance } from './monitor.js';
import { sendHeartbeat } from './heartbeat.js';

try {
  const config = loadConfig(),
    store = new Store(join(config.dataDir, 'app.db'), config.key);
  const { app, access, monitor, email, client, selected } = createApp(store, config);
  monitor.restart();
  email.restart();
  let stopping = false;
  const server = app.listen(config.port, '0.0.0.0', () =>
    process.stdout.write('Plex User Manager is ready.\n'),
  );
  let timer: ReturnType<typeof setTimeout>;
  async function tick() {
    if (stopping) return;
    const started = Date.now(),
      settings = monitor.settings();
    let ok: boolean | undefined;
    // Setup absence is unknown, never an outage.
    if (store.getSecret('server') && store.getSecret('plex')) {
      ok = await monitor.probe(() => client().probe(selected(), settings.timeoutSeconds * 1000));
    }
    await sendHeartbeat(
      store,
      !settings.enabled
        ? 'unknown'
        : inMaintenance(settings, Date.now())
          ? 'maintenance'
          : ok === undefined
            ? 'unknown'
            : ok
              ? 'healthy'
              : 'unhealthy',
    );
    if (stopping) return;
    timer = setTimeout(
      () => void tick(),
      Math.max(1000, settings.intervalSeconds * 1000 - (Date.now() - started)),
    );
  }
  void tick();
  async function expiries() {
    if (stopping || !store.getSecret('server') || !store.getSecret('plex')) return;
    try {
      await access.expire();
    } catch {
      store.audit('expiry.worker', 'scheduler', 'worker unavailable');
    }
  }
  // Expiry traffic cannot delay Plex probes or outbound heartbeats.
  void expiries();
  const expiryTimer = setInterval(() => void expiries(), 10000);
  const deliveryTimer = setInterval(
    () =>
      void email.drain().catch(() => store.audit('email.worker', 'queue', 'worker unavailable')),
    5000,
  );
  function stop() {
    stopping = true;
    clearTimeout(timer);
    clearInterval(deliveryTimer);
    clearInterval(expiryTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 20000).unref();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch {
  process.stderr.write(
    'Startup failed. Check deployment configuration, secret files, data permissions and database key.\n',
  );
  process.exitCode = 1;
}
