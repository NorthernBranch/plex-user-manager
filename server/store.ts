import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seal, unseal } from './crypto.js';
import { migrateCommunications, schemaVersion } from './migrations.js';

export class Store {
  db: DatabaseSync;
  constructor(
    public file: string,
    public key: string,
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > schemaVersion)
        throw new Error('Database schema is newer than this application.');
      if (version > 0 && this.get<string>('keyCheck')) this.getSecret('keyCheck');
      if (version === 0)
        this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE metadata (server TEXT NOT NULL, user TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', PRIMARY KEY(server,user));
      CREATE TABLE presets (id TEXT PRIMARY KEY, server TEXT NOT NULL, name TEXT NOT NULL, libraries TEXT NOT NULL);
      CREATE TABLE expiries (server TEXT NOT NULL, user TEXT NOT NULL, due INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(server,user));
      CREATE TABLE incidents (id TEXT PRIMARY KEY, started INTEGER NOT NULL, confirmed INTEGER NOT NULL, recovered INTEGER, observed INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL);
      CREATE TABLE timeline (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, incident TEXT, event TEXT NOT NULL);
      CREATE TABLE deliveries (id INTEGER PRIMARY KEY, incident TEXT NOT NULL, kind TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL, error TEXT, sent INTEGER, UNIQUE(incident,kind,recipient));
      PRAGMA user_version=1; COMMIT;`);
      // Check deployment key before serving or consuming jobs. Wrong keys fail closed.
      if (this.get<string>('keyCheck')) this.getSecret('keyCheck');
      else this.setSecret('keyCheck', 'valid');
      if (version < 2) migrateCommunications(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(key: string): T | undefined {
    const row = this.one<{ value: string }>('SELECT value FROM kv WHERE key=?', key);
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) {
    this.run(
      'INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  getSecret<T>(key: string): T | undefined {
    const value = this.get<string>(key);
    return value ? unseal<T>(value, this.key) : undefined;
  }
  setSecret(key: string, value: unknown) {
    this.set(key, seal(value, this.key));
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  one<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  audit(action: string, target: string, result: string) {
    this.run(
      'INSERT INTO audit(at,action,target,result) VALUES(?,?,?,?)',
      Date.now(),
      action,
      target,
      result,
    );
  }
  close() {
    this.db.close();
  }
}
