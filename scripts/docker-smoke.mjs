import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const platform = process.argv[2] ?? 'linux/amd64';
const name = `plex-smoke-${randomBytes(6).toString('hex')}`,
  volume = `${name}-data`,
  directory = resolve('.cache', name),
  keyFile = resolve(directory, 'key'),
  bootstrapFile = resolve(directory, 'bootstrap'),
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
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
writeFileSync(bootstrapFile, bootstrap, { mode: 0o600 });
// Only synthetic secrets: keep the host directory private, but allow the non-root
// container to read each individually mounted file, even with a restrictive umask.
chmodSync(keyFile, 0o444);
chmodSync(bootstrapFile, 0o444);

function diagnostics() {
  try {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    process.stderr.write(
      `Container state: ${state.Status}; exit code: ${state.ExitCode}; health: ${state.Health?.Status ?? 'unavailable'}.\n`,
    );
  } catch {
    process.stderr.write('Container state is unavailable.\n');
  }
  try {
    // Never print inspect environment, mount paths or arbitrary logs. Only these
    // fixed application messages are safe to include in public CI output.
    const messages = new Set([
      'Plex User Manager is ready.',
      'Startup failed. Check deployment configuration, secret files, data permissions and database key.',
    ]);
    const logs = spawnSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8' });
    if (logs.error || logs.status !== 0) throw new Error('Logs unavailable.');
    for (const line of [logs.stdout, logs.stderr].join('\n').split(/\r?\n/))
      if (messages.has(line)) process.stderr.write(`${line}\n`);
  } catch {
    process.stderr.write('Application startup messages are unavailable.\n');
  }
}

async function waitForReady(base) {
  for (let i = 0; i < 40; i++) {
    if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') break;
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Container did not serve /healthz successfully.');
}

function publishedUrl() {
  const binding = docker('port', name, '3000/tcp').match(/^127\.0\.0\.1:(\d+)$/);
  if (!binding) throw new Error('Expected a loopback-only published port.');
  return `http://127.0.0.1:${binding[1]}`;
}
let phase = 'image build';
try {
  execFileSync('docker', ['build', '--platform', platform, '-t', image, '.'], { stdio: 'inherit' });
  phase = 'container startup';
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
    '--mount',
    `type=bind,source=${keyFile},target=/run/secrets/key,readonly`,
    '--mount',
    `type=bind,source=${bootstrapFile},target=/run/secrets/bootstrap,readonly`,
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
  let base = publishedUrl();
  await waitForReady(base);
  phase = 'runtime checks';
  assert.equal(docker('inspect', '--format', '{{.Config.User}}', name), '1000:1000');
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert((await (await fetch(base)).text()).includes('Plex User Manager'));
  phase = 'administrator setup';
  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'synthetic-password', bootstrap }),
  });
  assert.equal(setup.status, 200);
  const session = await setup.json();
  assert(session.csrf);
  assert(setup.headers.get('set-cookie').includes('HttpOnly'));
  phase = 'restart readiness';
  docker('restart', name);
  // Docker can allocate a different ephemeral host port when starting again.
  base = publishedUrl();
  await waitForReady(base);
  phase = 'persisted administrator verification';
  const status = await fetch(`${base}/api/setup/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).initialized, true);
  phase = 'persisted administrator login';
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'administrator', password: 'synthetic-password' }),
  });
  assert.equal(login.status, 200);
  process.stdout.write(
    `Docker smoke test passed for ${platform}: non-root, read-only, one-origin frontend/API, protected setup, persistent SQLite restart.\n`,
  );
} catch {
  diagnostics();
  // Remote errors and assertion payloads can contain runtime data. Report only
  // safe diagnostics, and still fail CI after cleanup.
  process.stderr.write(
    `Docker smoke test failed during ${phase}. Review the safe diagnostics above.\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    docker('rm', '-f', name);
  } catch {}
  try {
    docker('volume', 'rm', volume);
  } catch {}
  rmSync(directory, { recursive: true, force: true });
}
