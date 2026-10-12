import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { communicationFixture } from './communication-helpers.js';
import type { Delivery } from '../server/email.js';

describe('file-backed communications recovery', () => {
  it('persists contacts, tokens, drafts, running jobs and ambiguous SMTP across reopen without extra logical mail', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'plex-communications-')),
      file = join(directory, 'app.db'),
      key = randomBytes(32).toString('hex');
    let store: Store | undefined;
    try {
      const now = Date.now();
      store = new Store(file, key);
      let f = communicationFixture(store);
      const c = await f.contact();
      f.contacts.issue(c.id, now);
      const token = f.token('preference-link');
      const row = f.communications.save(undefined, f.draft, now),
        preview = await f.communications.preview(row.id, now);
      f.communications.confirm(row.id, preview.ticket, now + 60000, true, now);
      store.run("UPDATE communication_jobs SET status='running'");
      store.close();
      store = undefined;
      store = new Store(file, key);
      f = communicationFixture(store);
      expect(f.contacts.view(token, now + 60000)).toMatchObject({
        email: c.email,
        scope: 'preferences',
      });
      f.communications.restart();
      await f.communications.tick(now + 60000);
      const message = store.one<Delivery>("SELECT * FROM deliveries WHERE kind='announcement'")!;
      store.run("UPDATE deliveries SET status='sending' WHERE id=?", message.id);
      store.close();
      store = undefined;
      store = new Store(file, key);
      f = communicationFixture(store);
      f.queue.restart(now + 61000);
      f.communications.restart();
      expect(store.one<Delivery>('SELECT * FROM deliveries WHERE id=?', message.id)?.error).toMatch(
        /acceptance is unknown/,
      );
      await f.communications.tick(now + 61000);
      await f.queue.drain(now + 61000);
      expect(store.all("SELECT * FROM deliveries WHERE kind='announcement'")).toHaveLength(1);
      expect(f.sender.mock.calls.filter(([, msg]) => msg.subject === f.draft.subject)).toHaveLength(
        1,
      );
      expect(
        f.sender.mock.calls.filter(([, msg]) => msg.subject === f.draft.subject)[0][1].messageId,
      ).toContain(`.announcement.${message.id}@`);
      expect(store.one<Delivery>('SELECT * FROM deliveries WHERE id=?', message.id)?.status).toBe(
        'sent',
      );
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
