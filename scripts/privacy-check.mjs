import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Do not print matches: a failed check must never copy private values to build output.
let files;
try {
  files = execFileSync(
    'git',
    [
      '-c',
      `safe.directory=${process.cwd().replaceAll('\\', '/')}`,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
} catch {
  throw new Error('Cannot enumerate public repository files.');
}
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
}
walk('dist');
const patterns = [
  /C:[\\/]Users[\\/][^\\/\s]+/i,
  /\/volume\d+\/(?!YOUR_DATA_DIRECTORY)[^\s"'<>]+/i,
  /(?:X-Plex-Token[=:]\s*["']?)(?!YOUR_|synthetic|\$)[A-Za-z0-9_-]{16,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[A-Z0-9._%+-]+@(?!(?:example\.(?:com|org|net)|plex-user-manager\.invalid)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i,
];
const failures = [];
for (const path of new Set(files)) {
  if (!existsSync(path)) continue;
  if (
    /(?:^|\/)(?:data|secrets|backups|runtime)\//.test(path) ||
    (/\.env(?:\.|$)/.test(path) && !path.endsWith('.env.example')) ||
    /\.(?:sqlite|db|pem|key)(?:$|-)/.test(path)
  ) {
    failures.push(path);
    continue;
  }
  if (/\.(?:png|jpg|webp|ico)$/.test(path)) continue;
  const data = readFileSync(path, 'utf8');
  if (patterns.some((p) => p.test(data))) failures.push(path);
}
if (failures.length) {
  process.stderr.write(
    `Privacy scan found ${failures.length} file(s) requiring review. Values are withheld.\n`,
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    `Privacy scan passed for ${new Set(files).size} repository and generated text files. Review binary screenshots separately.\n`,
  );
