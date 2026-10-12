import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const schemaVersion = 2;
export function migrateCommunications(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
    CREATE TABLE addresses (email TEXT PRIMARY KEY, verified_at INTEGER, unsubscribed INTEGER NOT NULL DEFAULT 0, blocked TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE contacts (id TEXT PRIMARY KEY, server TEXT NOT NULL DEFAULT '', user TEXT, email TEXT NOT NULL REFERENCES addresses(email), revision INTEGER NOT NULL DEFAULT 1, preferences TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, UNIQUE(server,user));
    CREATE UNIQUE INDEX standalone_contacts ON contacts(email) WHERE user IS NULL;
    CREATE TABLE contact_tokens (hash TEXT PRIMARY KEY, contact TEXT NOT NULL REFERENCES contacts(id), revision INTEGER NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER);
    CREATE TABLE memberships (server TEXT NOT NULL, user TEXT NOT NULL, share_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, welcome TEXT NOT NULL, observed INTEGER NOT NULL, PRIMARY KEY(server,share_id));
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, type TEXT NOT NULL, server TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, payload TEXT NOT NULL, audience TEXT NOT NULL DEFAULT '[]', scheduled INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE communication_jobs (id TEXT PRIMARY KEY, source TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, due INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0);
    ALTER TABLE expiries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE deliveries ADD COLUMN context TEXT;
    ALTER TABLE deliveries ADD COLUMN private_body TEXT;
    CREATE INDEX deliveries_due ON deliveries(status,next);
    CREATE INDEX communication_jobs_due ON communication_jobs(status,due);
    PRAGMA user_version=2;`);
    const row = db.prepare("SELECT value FROM kv WHERE key='monitor'").get() as
      { value: string } | undefined;
    const settings = row ? JSON.parse(row.value) : { recipients: [] };
    for (const recipient of settings.recipients ?? []) {
      const email = String(recipient.email).toLowerCase();
      db.prepare('INSERT OR IGNORE INTO addresses(email) VALUES(?)').run(email);
      db.prepare('INSERT OR IGNORE INTO contacts(id,email,preferences,legacy) VALUES(?,?,?,1)').run(
        randomUUID(),
        email,
        JSON.stringify({
          outage: !!recipient.outage,
          recovery: !!recipient.recovery,
          maintenance: false,
          announcement: false,
          welcome: false,
          expiry: false,
        }),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
