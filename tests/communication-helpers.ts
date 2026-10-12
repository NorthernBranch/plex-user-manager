import { vi } from 'vitest';
import { Communications } from '../server/communications.js';
import { Contacts } from '../server/contacts.js';
import { EmailQueue, type Sender, type Delivery } from '../server/email.js';
import { noPreferences } from '../server/communication-preferences.js';
import { unseal } from '../server/crypto.js';
import { memory, MockPlex, monitorSettings, testSmtp } from './helpers.js';
import type { Store } from '../server/store.js';

export function communicationFixture(persistent?: Store) {
  const store = persistent ?? memory(),
    plex = new MockPlex(),
    sender = vi.fn<Sender>().mockResolvedValue();
  const server = {
    id: 'synthetic',
    name: 'Sample server',
    url: 'http://localhost:32400',
    token: 'synthetic-token',
  };
  store.setSecret('server', server);
  store.setSecret('smtp', testSmtp);
  store.set('monitor', monitorSettings({ recipients: [] }));
  store.set('publicUrl', 'https://plex-admin.example.com');
  const queue = new EmailQueue(store, sender);
  const contacts = new Contacts(
    store,
    queue,
    'https://plex-admin.example.com',
    () => plex,
    () => server.id,
  );
  const communications = new Communications(
    store,
    queue,
    () => plex,
    () => server,
  );
  queue.setGuard((row, now) => communications.deliveryGuard(row, now));
  async function contact(
    user: string | null = '11',
    email = 'viewer@example.com',
    verified = true,
  ) {
    const row = await contacts.save(undefined, {
      user,
      email,
      active: true,
      preferences: {
        ...noPreferences,
        outage: true,
        recovery: true,
        announcement: true,
        maintenance: true,
        welcome: true,
        expiry: true,
      },
    });
    if (verified) store.run('UPDATE addresses SET verified_at=? WHERE email=?', Date.now(), email);
    return contacts.list().find((c) => c.id === row.id)!;
  }
  function token(kind: Delivery['kind']) {
    const row = store.one<Delivery>(
      'SELECT * FROM deliveries WHERE kind=? ORDER BY id DESC',
      kind,
    )!;
    return unseal<string>(row.private_body!, store.key).match(/#token=([a-f0-9]{64})/)![1];
  }
  const draft = {
    type: 'announcement',
    subject: 'Sample announcement',
    body: 'Synthetic message.',
    rule: { mode: 'all', ids: [] },
  };
  return { store, plex, sender, queue, contacts, communications, contact, token, draft, server };
}
