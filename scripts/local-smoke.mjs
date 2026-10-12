import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
async function allocatePort() {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const { port } = socket.address();
  await new Promise((r) => socket.close(r));
  return port;
}
const port = await allocatePort();
const directory = mkdtempSync(join(tmpdir(), 'plex-local-smoke-')),
  bootstrap = randomBytes(32).toString('hex'),
  keyFile = join(directory, 'encryption_key'),
  bootstrapFile = join(directory, 'bootstrap_secret'),
  origin = `http://localhost:${port}`;
let base = `http://127.0.0.1:${port}`;
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o400 });
writeFileSync(bootstrapFile, bootstrap, { mode: 0o400 });
let logs = '';
let child;
function start(port) {
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: origin,
      DATA_DIR: directory,
      BOOTSTRAP_SECRET: '',
      ENCRYPTION_KEY: '',
      BOOTSTRAP_SECRET_FILE: bootstrapFile,
      ENCRYPTION_KEY_FILE: keyFile,
      TRUSTED_PROXY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', () => {});
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
}
async function ready() {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Compiled server did not become healthy.');
}
try {
  start(port);
  await ready();
  assert((await (await fetch(base)).text()).includes('Plex User Manager'));
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  const response = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrap, username: 'administrator', password: 'synthetic-password' }),
  });
  assert.equal(response.status, 200);
  const { csrf } = await response.json(),
    cookie = response.headers.get('set-cookie').split(';')[0];
  assert(cookie);
  assert(csrf);
  const settings = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } });
  assert.equal(settings.status, 200);
  assert.equal(settings.headers.get('cache-control'), 'no-store');
  assert.equal((await settings.json()).server, null);
  await stop();
  let restartedPort;
  do {
    restartedPort = await allocatePort();
  } while (restartedPort === port);
  start(restartedPort);
  await ready();
  const status = await fetch(`${base}/api/setup/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).initialized, true);
  // The same session and CSRF token survive a real process restart, using the
  // same SQLite data directory but a different backend port.
  assert.equal((await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).status, 200);
  const logout = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).status, 401);
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'synthetic-password' }),
  });
  assert.equal(login.status, 200);
  assert(!logs.includes(bootstrap));
  process.stdout.write(
    'Compiled one-origin application smoke test passed: file-based secrets, frontend/API, bootstrap, persisted administrator/session across restart on a different port, CSRF/logout and no-store.\n',
  );
} finally {
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
