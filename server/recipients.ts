import type { Store } from './store.js';
import type { MonitorSettings } from './config.js';
import { categories, type Preferences, type Category } from './communications-config.js';

export type Contact = {
  id: string;
  server: string;
  user: string | null;
  email: string;
  revision: number;
  preferences: Preferences;
  legacy: boolean;
  active: boolean;
  verified: boolean;
  unsubscribed: boolean;
  blocked: Category[];
};
type ContactRow = Omit<
  Contact,
  'preferences' | 'legacy' | 'active' | 'verified' | 'unsubscribed' | 'blocked'
> & {
  preferences: string;
  legacy: number;
  active: number;
  verified_at: number | null;
  unsubscribed: number;
  blocked: string;
};
export function contactList(store: Store): Contact[] {
  return store
    .all<ContactRow>(
      'SELECT c.*,a.verified_at,a.unsubscribed,a.blocked FROM contacts c JOIN addresses a ON a.email=c.email',
    )
    .map((row) => ({
      ...row,
      preferences: JSON.parse(row.preferences),
      legacy: !!row.legacy,
      active: !!row.active,
      verified: row.verified_at !== null,
      unsubscribed: !!row.unsubscribed,
      blocked: JSON.parse(row.blocked),
    }));
}
export function contactReason(
  store: Store,
  contact: Contact,
  category: Category,
  personal = false,
  legacyAllowed = false,
): string | undefined {
  if (!contact.active) return 'Contact disabled';
  if (contact.unsubscribed || contact.blocked.includes(category) || !contact.preferences[category])
    return 'Category disabled or address unsubscribed';
  if (!contact.verified && !(legacyAllowed && contact.legacy)) return 'Address not verified';
  if (
    personal &&
    new Set(
      contactList(store)
        .filter((c) => c.active && c.email === contact.email && c.user)
        .map((c) => c.user),
    ).size > 1
  )
    return 'Shared address: account-specific messages blocked';
  return undefined;
}
export function notificationRecipients(store: Store, settings: MonitorSettings, server?: string) {
  const contacts = contactList(store);
  const byEmail = new Map<string, { email: string; outage: boolean; recovery: boolean }>();
  for (const standalone of settings.recipients) {
    const email = standalone.email.toLowerCase();
    const contact = contacts.find((c) => c.user === null && c.email === email);
    if (contact && (!contact.active || (!contact.legacy && !contact.verified))) continue;
    const address = store.one<{ unsubscribed: number; blocked: string }>(
      'SELECT unsubscribed,blocked FROM addresses WHERE email=?',
      email,
    );
    const blocked: string[] = address ? JSON.parse(address.blocked) : [];
    if (address?.unsubscribed) continue;
    byEmail.set(email, {
      email,
      outage: standalone.outage && !blocked.includes('outage'),
      recovery: standalone.recovery && !blocked.includes('recovery'),
    });
  }
  for (const contact of contacts.filter((c) => c.user !== null && c.server === server)) {
    const membership = store.one<{ status: string }>(
      'SELECT status FROM memberships WHERE server=? AND user=? ORDER BY observed DESC LIMIT 1',
      contact.server,
      contact.user!,
    );
    if (membership?.status === 'absent' || membership?.status === 'pending') continue;
    const previous = byEmail.get(contact.email) ?? {
      email: contact.email,
      outage: false,
      recovery: false,
    };
    previous.outage ||= !contactReason(store, contact, 'outage');
    previous.recovery ||= !contactReason(store, contact, 'recovery');
    byEmail.set(contact.email, previous);
  }
  return [...byEmail.values()].filter((r) => r.outage || r.recovery);
}
export function effectiveAddressPreferences(store: Store, email: string): Preferences {
  const contacts = contactList(store).filter((c) => c.email === email && c.active);
  return Object.fromEntries(
    categories.map((category) => [
      category,
      contacts.some(
        (c) => c.preferences[category] && !c.blocked.includes(category) && !c.unsubscribed,
      ),
    ]),
  ) as Preferences;
}
