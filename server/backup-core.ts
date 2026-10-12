import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export function snapshotDatabase(source: string, destination: string) {
  if (!existsSync(source)) throw new Error('Source database does not exist.');
  const db = new DatabaseSync(resolve(source));
  try {
    db.prepare('VACUUM INTO ?').run(resolve(destination));
  } finally {
    db.close();
  }
}
