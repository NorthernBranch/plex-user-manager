import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const platform = process.argv[2] ?? 'linux/amd64';
const name = `plex-smoke-${randomBytes(6).toString('hex')}`,
  volume = `${name}-data`,
  directory = resolve('.cache', name),
  image = 'plex-user-manager:smoke';
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// All secret values are ephemeral synthetic test values, never printed.
try {
  docker('info', '--format', '{{.ServerVersion}}');
} catch {
  process.stderr.write('Docker smoke test blocked: no accessible Docker daemon.\n');
  process.exit(1);
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
const bootstrap = randomBytes(32).toString('hex');
writeFileSync(resolve(directory, 'key'), randomBytes(32).toString('hex'), { mode: 0o644 });
writeFileSync(resolve(directory, 'bootstrap'), bootstrap, { mode: 0o644 });
try {
  execFileSync('docker', ['build', '--platform', platform, '-t', image, '.'], { stdio: 'inherit' });
  docker('volume', 'create', volume);
  docker(
    'run',
    '--platform',
    platform,
    '-d',
    '--name',
    name,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '-v',
    `${volume}:/data`,
    '-v',
    `${directory}:/run/secrets:ro`,
    '-p',
    '127.0.0.1::3000',
    '-e',
    'PUBLIC_URL=http://localhost:3000',
    '-e',
    'ENCRYPTION_KEY_FILE=/run/secrets/key',
    '-e',
    'BOOTSTRAP_SECRET_FILE=/run/secrets/bootstrap',
    image,
  );
  const port = docker('port', name, '3000/tcp').split(':').at(-1),
    base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = (await fetch(`${base}/healthz`)).ok;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(ready, 'Container did not become healthy.');
  assert.equal(docker('inspect', '--format', '{{.Config.User}}', name), '1000:1000');
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert((await (await fetch(base)).text()).includes('Plex User Manager'));
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'synthetic-password', bootstrap }),
  });
  assert.equal(setup.status, 200);
  const session = await setup.json();
  assert(session.csrf);
  assert(setup.headers.get('set-cookie').includes('HttpOnly'));
  docker('restart', name);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await (await fetch(`${base}/api/setup/status`)).json()).initialized, true);
  process.stdout.write(
    `Docker smoke test passed for ${platform}: non-root, read-only, one-origin frontend/API, protected setup, persistent SQLite restart.\n`,
  );
} finally {
  try {
    docker('rm', '-f', name);
  } catch {}
  try {
    docker('volume', 'rm', volume);
  } catch {}
  rmSync(directory, { recursive: true, force: true });
}
