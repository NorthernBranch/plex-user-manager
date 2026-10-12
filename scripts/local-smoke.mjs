import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const socket = createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const { port } = socket.address();
await new Promise((r) => socket.close(r));
const directory = mkdtempSync(join(tmpdir(), 'plex-local-smoke-')),
  bootstrap = randomBytes(32).toString('hex'),
  origin = `http://localhost:${port}`,
  base = `http://127.0.0.1:${port}`;
let logs = '';
const child = spawn(process.execPath, ['dist/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: origin,
    DATA_DIR: directory,
    BOOTSTRAP_SECRET: bootstrap,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    BOOTSTRAP_SECRET_FILE: '',
    ENCRYPTION_KEY_FILE: '',
    TRUSTED_PROXY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => {
  logs += chunk.toString();
});
child.stderr.on('data', () => {});
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = (await fetch(`${base}/healthz`)).ok;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, 'Compiled server did not become healthy.');
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
  assert(!logs.includes(bootstrap));
  process.stdout.write(
    'Compiled one-origin application smoke test passed: frontend, API, bootstrap, session, CSRF/logout and no-store.\n',
  );
} finally {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  rmSync(directory, { recursive: true, force: true });
}
