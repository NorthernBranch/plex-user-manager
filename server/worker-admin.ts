import { join } from 'node:path';
import { z } from 'zod';
import { secret } from './config.js';
import { Store } from './store.js';
import { EmailQueue } from './email.js';
// Operator-only commands. Docker/filesystem access is the authentication boundary.
try {
  const store = new Store(
    join(process.env.DATA_DIR ?? './data', 'worker.db'),
    secret(process.env, 'ENCRYPTION_KEY'),
  );
  try {
    if (process.argv[2] === 'test') {
      const recipient = z.email().parse(process.argv[3]);
      const queue = new EmailQueue(store);
      queue.test(recipient);
      process.stdout.write('Worker SMTP test queued. Check status after the delivery loop runs.\n');
    } else if (process.argv[2] === 'status') {
      process.stdout.write(
        JSON.stringify(
          {
            heartbeat: store.get('heartbeat.received') ?? null,
            state: store.get('health'),
            incidents: store.all('SELECT * FROM incidents ORDER BY confirmed DESC LIMIT 20'),
            timeline: store.all('SELECT * FROM timeline ORDER BY at DESC LIMIT 30'),
            deliveries: store.all(
              'SELECT kind,recipient,status,attempts,error FROM deliveries ORDER BY id DESC LIMIT 30',
            ),
          },
          null,
          2,
        ) + '\n',
      );
    } else throw new Error('Unknown command');
  } finally {
    store.close();
  }
} catch {
  process.stderr.write(
    'Worker command failed. Use test EMAIL or status with the deployed worker data directory and key.\n',
  );
  process.exitCode = 1;
}
