import type { Store } from './store.js';
import type { Delivery, DeliveryContext } from './email.js';
import type { CommunicationsSettings, Category } from './communications-config.js';
import type {
  Campaign,
  Job,
  Payload,
  Membership,
  Expiry,
  CommunicationSnapshot,
} from './communication-types.js';
import type { AudienceMember } from './communication-audience.js';
import { audienceContact } from './communication-audience.js';
import { contactList, contactReason } from './recipients.js';
import { AppError } from './errors.js';
export type DeliveryRuntime = {
  store: Store;
  settings: () => CommunicationsSettings;
  snapshot: () => Promise<CommunicationSnapshot>;
  campaign: (id: string) => Campaign;
};
export async function guardCommunication(
  runtime: DeliveryRuntime,
  row: Delivery,
  now: number,
): Promise<string | undefined> {
  if (!row.context) return;
  const c = JSON.parse(row.context) as DeliveryContext;
  if (c.source === 'contact') {
    const contact = contactList(runtime.store).find((x) => x.id === c.contactId),
      token = runtime.store.one<{ expires: number; consumed: number | null }>(
        'SELECT expires,consumed FROM contact_tokens WHERE hash=?',
        c.tokenHash!,
      );
    return !contact?.active ||
      contact.unsubscribed ||
      contact.email !== row.recipient ||
      contact.revision !== c.revision ||
      !token ||
      token.consumed !== null ||
      token.expires <= now
      ? 'Contact link expired or address changed'
      : undefined;
  }
  if (c.deadline !== undefined && now >= c.deadline) return 'Notice deadline passed';
  const job = c.jobId
    ? runtime.store.one<Job>('SELECT * FROM communication_jobs WHERE id=?', c.jobId)
    : undefined;
  if (job && ['superseded', 'cancelled'].includes(job.status)) return 'Scheduling job is obsolete';
  if (c.source === 'campaign') {
    const campaign = runtime.campaign(c.campaignId!);
    if (campaign.revision !== c.revision) return 'Communication revision changed';
    if (row.kind === 'maintenance' && job?.kind === 'maintenance') {
      const p = JSON.parse(campaign.payload) as Payload;
      const latest = [...(p.leads ?? [])]
        .sort((a, b) => a - b)
        .find((lead) => Date.parse(p.start!) - lead * 1000 <= now);
      if (JSON.parse(job.payload).lead !== latest)
        return 'Older maintenance notice superseded by a later due notice';
    }
    const members = (JSON.parse(campaign.audience) as AudienceMember[]).filter(
      (m) => c.contactIds?.includes(m.contactId) && m.email === row.recipient,
    );
    const snapshot = await runtime.snapshot();
    if (snapshot.server.id !== campaign.server)
      throw new AppError(409, 'SERVER', 'Selected server temporarily unavailable.');
    if (
      !members.some(
        (m) =>
          !audienceContact(
            runtime.store,
            m,
            c.category as Category,
            snapshot.users,
            (JSON.parse(campaign.payload) as Payload).rule,
          ).reason,
      )
    )
      return 'No confirmed eligible contact remains at this address';
    if (runtime.campaign(campaign.id).revision !== c.revision)
      return 'Communication edited during eligibility check';
  }
  if (c.source === 'welcome' || c.source === 'expiry' || c.source === 'expiry-failure') {
    if (c.source !== 'welcome') {
      const expiry = runtime.store.one<Expiry>(
        'SELECT * FROM expiries WHERE server=? AND user=?',
        c.server!,
        c.user!,
      );
      if (
        !runtime.settings().expiry.enabled ||
        c.settingsRevision !==
          (runtime.store.get<number>('communications.settingsRevision') ?? 0) ||
        !expiry ||
        expiry.revision !== c.revision ||
        !['pending', 'running', 'failed'].includes(expiry.status) ||
        (c.source === 'expiry' && expiry.due <= now) ||
        (c.source === 'expiry-failure' && !expiry.error)
      )
        return 'Expiry changed, cancelled or already completed';
      if (c.source === 'expiry') {
        const latest = [...runtime.settings().expiry.leads]
          .sort((a, b) => a - b)
          .find((lead) => expiry.due - lead * 1000 <= now);
        if (c.lead !== latest) return 'Older expiry reminder superseded by a later due reminder';
      }
      if (!c.contactId) {
        const address = runtime.store.one<{ unsubscribed: number; blocked: string }>(
          'SELECT unsubscribed,blocked FROM addresses WHERE email=?',
          row.recipient,
        );
        if (
          !runtime
            .settings()
            .expiry.administrators.map((e) => e.toLowerCase())
            .includes(row.recipient) ||
          address?.unsubscribed ||
          JSON.parse(address?.blocked ?? '[]').includes('expiry')
        )
          return 'Administrator reminder preferences changed';
      }
    }
    if (c.contactId) {
      const contact = contactList(runtime.store).find((x) => x.id === c.contactId);
      if (
        !contact ||
        contact.email !== row.recipient ||
        contactReason(runtime.store, contact, c.category as Category, true) ||
        (c.source === 'welcome' && contact.revision !== c.revision)
      )
        return 'Contact no longer eligible for account-specific communications';
      if (c.source === 'welcome' && contact.revision !== c.revision)
        return 'Contact address changed';
    }
    if (c.source !== 'expiry-failure') {
      const snapshot = await runtime.snapshot();
      if (snapshot.server.id !== c.server)
        throw new AppError(409, 'SERVER', 'Select the relevant server before delivery.');
      if (
        !snapshot.users.some(
          (u) =>
            u.id === c.user &&
            u.shareId === c.shareId &&
            u.kind !== 'pending' &&
            u.libraries.length,
        )
      )
        return 'Confirmed membership no longer exists';
      if (c.source === 'welcome') {
        const membership = runtime.store.one<Membership>(
          'SELECT * FROM memberships WHERE server=? AND share_id=?',
          c.server!,
          c.shareId!,
        );
        if (membership?.generation !== c.generation) return 'Membership generation changed';
      } else {
        const expiry = runtime.store.one<Expiry>(
          'SELECT * FROM expiries WHERE server=? AND user=?',
          c.server!,
          c.user!,
        );
        if (
          !expiry ||
          expiry.revision !== c.revision ||
          !['pending', 'running', 'failed'].includes(expiry.status) ||
          expiry.due <= now ||
          c.settingsRevision !== (runtime.store.get<number>('communications.settingsRevision') ?? 0)
        )
          return 'Expiry changed before delivery';
      }
    }
    if (c.contactId) {
      const contact = contactList(runtime.store).find((x) => x.id === c.contactId);
      if (
        !contact ||
        contact.email !== row.recipient ||
        contactReason(runtime.store, contact, c.category as Category, true) ||
        (c.source === 'welcome' && contact.revision !== c.revision)
      )
        return 'Recipient preferences changed during eligibility check';
    } else if (c.source === 'expiry') {
      const address = runtime.store.one<{ unsubscribed: number; blocked: string }>(
        'SELECT unsubscribed,blocked FROM addresses WHERE email=?',
        row.recipient,
      );
      if (address?.unsubscribed || JSON.parse(address?.blocked ?? '[]').includes('expiry'))
        return 'Administrator preferences changed during eligibility check';
    }
  }
  return undefined;
}
