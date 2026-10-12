import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const socket = createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const { port } = socket.address();
await new Promise((r) => socket.close(r));
const directory = mkdtempSync(join(tmpdir(), 'plex-worker-smoke-')),
  configFile = join(directory, 'worker-config.json'),
  key = randomBytes(32).toString('hex'),
  heartbeatKey = randomBytes(32).toString('hex'),
  base = `http://127.0.0.1:${port}`;
writeFileSync(
  configFile,
  JSON.stringify({
    heartbeatGraceSeconds: 30,
    smtp: {
      host: '127.0.0.1',
      port: 1,
      tls: 'implicit',
      username: '',
      password: '',
      from: 'alerts@example.com',
    },
    monitor: {
      enabled: true,
      intervalSeconds: 5,
      timeoutSeconds: 1,
      failureSeconds: 5,
      recoveryCount: 2,
      authority: 'local',
      recipients: [{ email: 'synthetic@example.com', outage: true, recovery: true }],
      maintenance: [],
      outageSubject: 'Synthetic outage',
      outageBody: 'Synthetic {{incident}}',
      recoverySubject: 'Synthetic recovery',
      recoveryBody: 'Synthetic {{downtime}}',
    },
  }),
  { mode: 0o600 },
);
let child;
const env = {
  ...process.env,
  PORT: String(port),
  DATA_DIR: directory,
  WORKER_CONFIG_FILE: configFile,
  ENCRYPTION_KEY: key,
  ENCRYPTION_KEY_FILE: '',
  HEARTBEAT_KEY: heartbeatKey,
  HEARTBEAT_KEY_FILE: '',
};
const start = () => {
  child = spawn(process.execPath, ['dist/server/worker.js'], { env, stdio: 'ignore' });
};
const stop = async () => {
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
};
const ready = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Worker did not become healthy.');
};
const waitFor = async (fn) => {
  for (let i = 0; i < 140; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Worker transition did not occur.');
};
const heartbeat = async (state) => {
  const body = JSON.stringify({ at: Date.now(), nonce: randomUUID(), state }),
    signature = createHmac('sha256', heartbeatKey).update(body).digest('hex');
  return fetch(`${base}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Heartbeat-Signature': signature },
    body,
  });
};
let db;
try {
  start();
  await ready();
  assert.equal(
    (
      await fetch(`${base}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await heartbeat('unhealthy')).status, 204);
  db = new DatabaseSync(join(directory, 'worker.db'));
  await waitFor(() => db.prepare('SELECT count(*) AS n FROM incidents').get().n === 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 1);
  await stop();
  start();
  await ready();
  assert.equal(
    JSON.parse(db.prepare("SELECT value FROM kv WHERE key='health'").get().value).unknown,
    true,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM incidents').get().n, 1);
  assert.equal((await heartbeat('healthy')).status, 204);
  await waitFor(() => db.prepare('SELECT recovered FROM incidents').get().recovered !== null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM incidents').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 2);
  process.stdout.write(
    'Compiled external worker smoke test passed: signed heartbeat, forgery rejection, independent incident/queue persistence, restart gap and recovery. SMTP used a closed loopback port; no email was sent.\n',
  );
} finally {
  if (child?.exitCode === null) await stop();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
