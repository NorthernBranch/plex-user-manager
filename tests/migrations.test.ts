import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';
import { Contacts } from '../server/contacts.js';
import { EmailQueue } from '../server/email.js';
import { MockPlex, monitorSettings } from './helpers.js';

function versionOne(file: string, key: string) {
  const store = new Store(file, key);
  // Construct the exact previous schema and persist representative pre-upgrade state.
  store.db.exec(`DROP TABLE contact_tokens; DROP TABLE contacts; DROP TABLE addresses;
    DROP INDEX deliveries_due;
    DROP TABLE memberships; DROP TABLE campaigns; DROP TABLE communication_jobs;
    ALTER TABLE expiries DROP COLUMN revision;
    ALTER TABLE deliveries DROP COLUMN context;
    ALTER TABLE deliveries DROP COLUMN private_body;
    PRAGMA user_version=1;`);
  store.set('monitor', monitorSettings());
  store.setSecret('plex', { token: 'synthetic-owner-token' });
  store.run("INSERT INTO admin VALUES(1,'administrator','synthetic-password-hash')");
  store.run("INSERT INTO sessions VALUES('synthetic-session','synthetic-csrf',9999999999999)");
  store.run("INSERT INTO metadata VALUES('synthetic','11','Synthetic note')");
  store.run("INSERT INTO presets VALUES('synthetic-preset','synthetic','Sample preset','[\"1\"]')");
  store.run("INSERT INTO expiries(server,user,due,status) VALUES('synthetic','11',100,'pending')");
  store.run("INSERT INTO incidents VALUES('synthetic-incident',0,100,NULL,100,'Local')");
  store.run(
    "INSERT INTO deliveries(incident,kind,recipient,subject,body,status,next) VALUES('synthetic-incident','outage','one@example.com','Sample','Synthetic body','pending',100)",
  );
  store.audit('synthetic.test', 'application', 'Synthetic audit');
  return store;
}
describe('transactional communications migration', () => {
  it('preserves all version-one data and old recipient behaviour without marking addresses verified', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-migration-'));
    const file = join(directory, 'app.db'),
      key = randomBytes(32).toString('hex');
    let store: Store | undefined;
    try {
      store = versionOne(file, key);
      store.close();
      store = new Store(file, key);
      expect(store.one<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(2);
      for (const table of [
        'admin',
        'sessions',
        'metadata',
        'presets',
        'expiries',
        'incidents',
        'deliveries',
        'audit',
      ])
        expect(store.all(`SELECT * FROM ${table}`)).toHaveLength(1);
      expect(store.getSecret('plex')).toEqual({ token: 'synthetic-owner-token' });
      expect(store.one<{ revision: number }>('SELECT revision FROM expiries')?.revision).toBe(1);
      const contacts = new Contacts(
        store,
        new EmailQueue(store),
        'https://plex-admin.example.com',
        () => new MockPlex(),
        () => 'synthetic',
      ).list();
      expect(contacts).toHaveLength(2);
      expect(
        contacts.every(
          (c) =>
            !c.verified &&
            c.legacy &&
            !c.preferences.welcome &&
            !c.preferences.announcement &&
            c.preferences.outage,
        ),
      ).toBe(true);
      store.close();
      store = new Store(file, key);
      expect(store.all('SELECT * FROM contacts')).toHaveLength(2);
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not partially migrate on invalid legacy configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-migration-')),
      file = join(directory, 'app.db'),
      key = randomBytes(32).toString('hex');
    try {
      const store = versionOne(file, key);
      store.run("UPDATE kv SET value='invalid-json' WHERE key='monitor'");
      store.close();
      expect(() => new Store(file, key)).toThrow();
      const db = new DatabaseSync(file);
      try {
        expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name='contacts'").get(),
        ).toBeUndefined();
        expect(db.prepare('SELECT * FROM sessions').all()).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects a wrong deployment key before changing an existing schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-migration-')),
      file = join(directory, 'app.db');
    try {
      versionOne(file, randomBytes(32).toString('hex')).close();
      expect(() => new Store(file, randomBytes(32).toString('hex'))).toThrow();
      const db = new DatabaseSync(file);
      try {
        expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
