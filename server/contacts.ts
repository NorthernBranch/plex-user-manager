import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash } from './crypto.js';
import { Store } from './store.js';
import { AppError } from './errors.js';
import type { PlexAdapter } from './plex.js';
import { EmailQueue } from './email.js';
import {
  categories,
  preferencesSchema,
  noPreferences,
  type Preferences,
} from './communications-config.js';
import { contactList, effectiveAddressPreferences } from './recipients.js';
import { defaultMonitor, type MonitorSettings } from './config.js';

export const contactInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  preferences: preferencesSchema,
  active: z.boolean(),
  user: z.string().min(1).nullable(),
  confirmEmailChange: z.boolean().default(false),
});
export class Contacts {
  constructor(
    private store: Store,
    private queue: EmailQueue,
    private publicUrl: string,
    private client: () => PlexAdapter,
    private selected: () => string,
  ) {}
  list() {
    return contactList(this.store);
  }
  async save(id: string | undefined, raw: unknown) {
    const input = contactInput.parse(raw);
    const current = id ? this.list().find((c) => c.id === id) : undefined;
    if (id && !current) throw new AppError(404, 'CONTACT', 'Contact not found.');
    if (current && current.user !== input.user)
      throw new AppError(
        409,
        'CONTACT',
        'Contact identity cannot be changed. Create a separate contact.',
      );
    const server = input.user ? this.selected() : '';
    if (current?.user && current.server !== server)
      throw new AppError(409, 'SERVER', 'Select this contact’s server before editing.');
    if (input.user) {
      const member = (await this.client().users(server)).find((u) => u.id === input.user);
      if (!member || member.kind === 'pending')
        throw new AppError(
          409,
          'CONTACT',
          'Link only a confirmed account on this server. Pending invitation identities are not matched by name or email.',
        );
    }
    if (current && current.email !== input.email && !input.confirmEmailChange)
      throw new AppError(
        409,
        'CONFIRM',
        'Confirm changing the notification address. Verification will be reset.',
      );
    const contactId = id ?? randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO addresses(email) VALUES(?)', input.email);
      const existing = this.store.one<{ id: string }>(
        'SELECT id FROM contacts WHERE (server=? AND user=?) OR (? IS NULL AND user IS NULL AND email=?)',
        server,
        input.user,
        input.user,
        input.email,
      );
      if (existing && existing.id !== id)
        throw new AppError(
          409,
          'CONTACT',
          'This identity or standalone address already has a contact.',
        );
      if (current)
        this.store.run(
          'UPDATE contacts SET email=?,preferences=?,active=?,revision=revision+?,legacy=CASE WHEN email<>? THEN 0 ELSE legacy END WHERE id=?',
          input.email,
          JSON.stringify(input.preferences),
          Number(input.active),
          Number(current.email !== input.email),
          input.email,
          contactId,
        );
      else
        this.store.run(
          'INSERT INTO contacts(id,server,user,email,preferences,active) VALUES(?,?,?,?,?,?)',
          contactId,
          server,
          input.user,
          input.email,
          JSON.stringify(input.preferences),
          Number(input.active),
        );
      if (current && current.email !== input.email) {
        this.store.run('UPDATE addresses SET verified_at=NULL WHERE email=?', input.email);
        this.store.run(
          'UPDATE contact_tokens SET consumed=? WHERE contact=?',
          Date.now(),
          contactId,
        );
      }
      this.store.audit(
        'contact.save',
        contactId,
        'address and preferences saved; identity kept separate',
      );
      if (!input.user) this.syncStandaloneSettings();
    });
    return this.list().find((c) => c.id === contactId)!;
  }
  syncStandaloneSettings() {
    const settings = this.store.get<MonitorSettings>('monitor') ?? defaultMonitor;
    const recipients = this.list()
      .filter((c) => c.user === null && c.active)
      .map((c) => ({
        email: c.email,
        outage: c.preferences.outage,
        recovery: c.preferences.recovery,
      }));
    this.store.set('monitor', { ...settings, recipients });
  }
  syncLegacy(recipients: MonitorSettings['recipients']) {
    const existing = this.list().filter((c) => c.user === null);
    for (const contact of existing)
      this.store.run(
        'UPDATE contacts SET active=? WHERE id=?',
        Number(recipients.some((r) => r.email.toLowerCase() === contact.email)),
        contact.id,
      );
    for (const recipient of recipients) {
      const email = recipient.email.toLowerCase(),
        previous = existing.find((c) => c.email === email);
      const preferences = {
        ...(previous?.preferences ?? noPreferences),
        outage: recipient.outage,
        recovery: recipient.recovery,
      };
      this.store.run('INSERT OR IGNORE INTO addresses(email) VALUES(?)', email);
      if (previous)
        this.store.run(
          'UPDATE contacts SET preferences=?,active=1 WHERE id=?',
          JSON.stringify(preferences),
          previous.id,
        );
      else
        this.store.run(
          'INSERT INTO contacts(id,email,preferences,legacy) VALUES(?,?,?,1)',
          randomUUID(),
          email,
          JSON.stringify(preferences),
        );
    }
  }
  issue(contactId: string, now = Date.now()) {
    const contact = this.list().find((c) => c.id === contactId && c.active);
    if (!contact) throw new AppError(404, 'CONTACT', 'Active contact not found.');
    if (!this.store.getSecret('smtp')) throw new AppError(409, 'SMTP', 'Configure SMTP first.');
    if (contact.unsubscribed)
      throw new AppError(
        409,
        'CONTACT',
        'Address unsubscribed. Do not send another link without recipient consent.',
      );
    const links: string[] = [];
    this.store.transaction(() => {
      for (const scope of ['verify', 'preferences'] as const) {
        if (scope === 'verify' && contact.verified) continue;
        const token = randomBytes(32).toString('hex'),
          digest = hash(token);
        this.store.run(
          'UPDATE contact_tokens SET consumed=? WHERE contact=? AND scope=? AND consumed IS NULL',
          now,
          contactId,
          scope,
        );
        this.store.run(
          'INSERT INTO contact_tokens(hash,contact,revision,scope,expires) VALUES(?,?,?,?,?)',
          digest,
          contactId,
          contact.revision,
          scope,
          now + (scope === 'verify' ? 86400000 : 1209600000),
        );
        const body = `${scope === 'verify' ? 'Verify this notification address (24-hour link). Verification does not enable any notification category.' : 'Manage communications preferences for this email address (14-day link). This does not grant Plex or administrator access.'}\n${this.publicUrl}/recipient#token=${token}\nOpening the link does not perform an action. Confirm on the page.`;
        this.queue.enqueue({
          key: `contact:${digest}`,
          kind: scope === 'verify' ? 'verification' : 'preference-link',
          recipient: contact.email,
          subject:
            scope === 'verify'
              ? 'Verify your notification address'
              : 'Manage notification preferences',
          body,
          private: true,
          context: { source: 'contact', contactId, revision: contact.revision, tokenHash: digest },
          now,
        });
        links.push(scope);
      }
      this.store.audit('contact.links', contactId, 'scoped links queued');
    });
    return { status: 'queued', links };
  }
  token(raw: string, now = Date.now(), scope?: string) {
    if (!/^[a-f0-9]{64}$/.test(raw))
      throw new AppError(
        403,
        'LINK',
        'Link invalid or expired. Request a new link from the administrator.',
      );
    const token = this.store.one<{
      hash: string;
      contact: string;
      revision: number;
      scope: string;
      expires: number;
      consumed: number | null;
    }>('SELECT * FROM contact_tokens WHERE hash=?', hash(raw));
    const contact = token ? this.list().find((c) => c.id === token.contact) : undefined;
    if (
      !token ||
      !contact?.active ||
      token.revision !== contact.revision ||
      token.expires <= now ||
      token.consumed !== null ||
      (scope && token.scope !== scope)
    )
      throw new AppError(
        403,
        'LINK',
        'Link invalid or expired. Request a new link from the administrator.',
      );
    return { token, contact };
  }
  view(raw: string, now = Date.now()) {
    const { token, contact } = this.token(raw, now);
    return {
      email: contact.email,
      verified: contact.verified,
      unsubscribed: contact.unsubscribed,
      preferences: effectiveAddressPreferences(this.store, contact.email),
      scope: token.scope,
      expires: token.expires,
    };
  }
  verify(raw: string, confirm: boolean, now = Date.now()) {
    if (!confirm) throw new AppError(400, 'CONFIRM', 'Confirm address verification.');
    const { token, contact } = this.token(raw, now, 'verify');
    this.store.transaction(() => {
      this.store.run('UPDATE addresses SET verified_at=? WHERE email=?', now, contact.email);
      this.store.run('UPDATE contact_tokens SET consumed=? WHERE hash=?', now, token.hash);
      this.store.audit('contact.verify', contact.id, 'address verified; consent unchanged');
    });
    return { verified: true };
  }
  preferences(
    raw: string,
    preferences: Preferences,
    unsubscribed: boolean,
    confirm: boolean,
    now = Date.now(),
  ) {
    if (!confirm) throw new AppError(400, 'CONFIRM', 'Confirm preference changes.');
    const { contact } = this.token(raw, now, 'preferences');
    const parsed = preferencesSchema.parse(preferences);
    this.store.transaction(() => {
      this.store.run(
        'UPDATE addresses SET unsubscribed=?,blocked=? WHERE email=?',
        Number(unsubscribed),
        JSON.stringify(categories.filter((c) => !parsed[c])),
        contact.email,
      );
      this.store.run(
        'UPDATE contacts SET preferences=? WHERE email=?',
        JSON.stringify(parsed),
        contact.email,
      );
      this.syncStandaloneSettings();
      this.store.audit(
        'contact.preferences',
        contact.id,
        'address-wide recipient preferences saved',
      );
    });
    return this.view(raw, now);
  }
}
