import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig, monitorSchema } from '../server/config.js';
import { seal, unseal } from '../server/crypto.js';
import { monitorSettings, memory } from './helpers.js';
describe('configuration and secrets', () => {
  it('fails closed for missing and malformed secrets, insecure public URL and broad proxy trust', () => {
    const valid = {
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      BOOTSTRAP_SECRET: randomBytes(32).toString('hex'),
    };
    for (const input of [
      {},
      { ...valid, ENCRYPTION_KEY: 'bad' },
      { ...valid, BOOTSTRAP_SECRET: 'short' },
      { ...valid, PUBLIC_URL: 'http://plex-admin.example.com' },
      { ...valid, TRUSTED_PROXY: '0.0.0.0/0' },
      { ...valid, ENCRYPTION_KEY_FILE: 'missing-file' },
    ])
      expect(() => loadConfig(input)).toThrow();
    expect(
      loadConfig({
        ...valid,
        PUBLIC_URL: 'https://plex-admin.example.com',
        TRUSTED_PROXY: '172.30.0.2/32',
      }).secure,
    ).toBe(true);
  });
  it('encrypts secrets and rejects wrong key and tampering', () => {
    const key = randomBytes(32).toString('hex'),
      saved = seal({ password: 'synthetic-secret' }, key);
    expect(saved).not.toContain('synthetic-secret');
    expect(unseal(saved, key)).toEqual({ password: 'synthetic-secret' });
    expect(() => unseal(saved, randomBytes(32).toString('hex'))).toThrow();
    const db = memory();
    db.setSecret('smtp', { password: 'synthetic-secret' });
    expect(db.one<{ value: string }>("SELECT value FROM kv WHERE key='smtp'")?.value).not.toContain(
      'synthetic-secret',
    );
    db.close();
  });
  it('validates settings, unique recipients and non-overlapping request duration', () => {
    expect(monitorSchema.safeParse(monitorSettings()).success).toBe(true);
    for (const value of [
      monitorSettings({ timeoutSeconds: 5 }),
      monitorSettings({ failureSeconds: 1 }),
      monitorSettings({ recipients: [{ email: 'bad', outage: true, recovery: true }] }),
      monitorSettings({ outageSubject: 'header\ninjection' }),
      monitorSettings({
        maintenance: [{ start: '2026-01-01T00:00:00Z', end: '2025-01-01T00:00:00Z' }],
      }),
    ])
      expect(monitorSchema.safeParse(value).success).toBe(false);
  });
});
