import { z } from 'zod';
import type { Store } from './store.js';
import type { PlexUser } from './plex.js';
import { contactList, contactReason, type Contact } from './recipients.js';
import type { Category } from './communications-config.js';

export const audienceSchema = z
  .object({ mode: z.enum(['all', 'users', 'libraries']), ids: z.array(z.string().min(1)).max(200) })
  .refine((v) => v.mode === 'all' || v.ids.length > 0, 'Select at least one user or library.');
export type AudienceRule = z.infer<typeof audienceSchema>;
export type AudienceMember = {
  contactId: string;
  revision: number;
  email: string;
  server: string;
  user: string | null;
  shareId: string | null;
};
export function recipientPreview(
  store: Store,
  server: string,
  users: PlexUser[],
  rule: AudienceRule,
  category: Category,
) {
  const included: AudienceMember[] = [],
    excluded: { contactId: string; email: string; reason: string }[] = [];
  for (const contact of contactList(store).filter((c) => c.user === null || c.server === server)) {
    const member = contact.user ? users.find((u) => u.id === contact.user) : undefined;
    let reason = contactReason(store, contact, category);
    if (
      !reason &&
      contact.user &&
      (!member || member.kind === 'pending' || !member.libraries.length)
    )
      reason = 'No confirmed access to this server';
    if (!reason && rule.mode === 'users' && (!contact.user || !rule.ids.includes(contact.user)))
      reason = 'Not in selected users';
    if (
      !reason &&
      rule.mode === 'libraries' &&
      (!member || !member.libraries.some((id) => rule.ids.includes(id)))
    )
      reason = 'No access to selected libraries';
    if (reason) excluded.push({ contactId: contact.id, email: contact.email, reason });
    else
      included.push({
        contactId: contact.id,
        revision: contact.revision,
        email: contact.email,
        server: contact.server,
        user: contact.user,
        shareId: member?.shareId ?? null,
      });
  }
  return {
    included,
    excluded,
    includedCount: new Set(included.map((c) => c.email)).size,
    excludedCount: excluded.length,
    duplicateCount: included.length - new Set(included.map((c) => c.email)).size,
  };
}
export function audienceContact(
  store: Store,
  member: AudienceMember,
  category: Category,
  users: PlexUser[],
  rule?: AudienceRule,
): { contact?: Contact; reason?: string } {
  const contact = contactList(store).find((c) => c.id === member.contactId);
  if (!contact || contact.revision !== member.revision || contact.email !== member.email)
    return { reason: 'Notification address changed or contact removed' };
  const reason = contactReason(store, contact, category);
  if (reason) return { reason };
  if (member.user) {
    const user = users.find(
      (u) =>
        u.id === member.user &&
        u.shareId === member.shareId &&
        u.kind !== 'pending' &&
        u.libraries.length > 0,
    );
    if (!user) return { reason: 'Confirmed membership no longer matches' };
    if (rule?.mode === 'libraries' && !user.libraries.some((id) => rule.ids.includes(id)))
      return { reason: 'No longer has access to selected libraries' };
  }
  return { contact };
}
