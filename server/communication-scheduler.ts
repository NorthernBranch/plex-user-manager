import type { Store } from './store.js';
import type { EmailQueue } from './email.js';
import type { PlexUser, Library, SelectedServer } from './plex.js';
import {
  subjectSchema,
  renderTemplate,
  type CommunicationsSettings,
} from './communications-config.js';
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
export type SchedulerRuntime = {
  store: Store;
  queue: EmailQueue;
  settings: () => CommunicationsSettings;
  campaign: (id: string) => Campaign;
  maintenanceContent: (
    row: Pick<Campaign, 'subject' | 'body' | 'payload'>,
    change: string,
  ) => { subject: string; body: string };
  job: (
    id: string,
    source: string,
    revision: number,
    kind: string,
    due: number,
    payload: unknown,
    status?: string,
    reason?: string | null,
  ) => void;
  enqueueWelcome: (
    user: PlexUser,
    libraries: Library[],
    member: Membership,
    contactId: string,
    key: string,
    now: number,
  ) => void;
};
export function planCommunicationJobs(
  runtime: SchedulerRuntime,
  snapshot: { server: SelectedServer; users: PlexUser[]; libraries: Library[] },
  now: number,
) {
  for (const row of runtime.store.all<Campaign>(
    "SELECT * FROM campaigns WHERE type='maintenance' AND status IN ('scheduled','dispatched') AND server=?",
    snapshot.server.id,
  )) {
    const p = JSON.parse(row.payload) as Payload,
      start = Date.parse(p.start!);
    const leads = [...new Set(p.leads ?? [])].sort((a, b) => a - b);
    const catchup = leads.find((lead) => start - lead * 1000 <= now);
    for (const lead of leads) {
      const stale = now >= start || (start - lead * 1000 <= now && lead !== catchup);
      runtime.job(
        `${row.id}:${row.revision}:notice:${lead}`,
        row.id,
        row.revision,
        'maintenance',
        start - lead * 1000,
        { lead },
        stale ? 'superseded' : 'scheduled',
        stale ? 'Missed or obsolete advance notice; no catch-up burst.' : null,
      );
    }
  }
  if (runtime.settings().welcome.enabled)
    for (const member of runtime.store.all<Membership>(
      "SELECT * FROM memberships WHERE server=? AND welcome='eligible' AND status='active'",
      snapshot.server.id,
    )) {
      const user = snapshot.users.find(
        (u) =>
          u.id === member.user &&
          u.shareId === member.share_id &&
          u.kind === 'shared' &&
          u.libraries.length,
      );
      const contact = contactList(runtime.store).find(
        (c) => c.server === member.server && c.user === member.user,
      );
      if (user && contact && !contactReason(runtime.store, contact, 'welcome', true)) {
        runtime.enqueueWelcome(
          user,
          snapshot.libraries,
          member,
          contact.id,
          `${member.server}:${member.share_id}:${member.generation}:auto`,
          now,
        );
        runtime.store.run(
          "UPDATE memberships SET welcome='queued' WHERE server=? AND share_id=?",
          member.server,
          member.share_id,
        );
      }
    }
  const settings = runtime.settings().expiry;
  if (settings.enabled)
    for (const expiry of runtime.store.all<Expiry>(
      "SELECT * FROM expiries WHERE server=? AND status IN ('pending','running','failed')",
      snapshot.server.id,
    )) {
      const settingsRevision = runtime.store.get<number>('communications.settingsRevision') ?? 0;
      const source = `expiry:${expiry.server}:${expiry.user}:${expiry.revision}:settings:${settingsRevision}`;
      const leads = [...settings.leads].sort((a, b) => a - b),
        catchup = leads.find((lead) => expiry.due - lead * 1000 <= now);
      for (const lead of leads)
        for (const role of ['user', 'admin']) {
          if (
            (role === 'user' && !settings.user) ||
            (role === 'admin' && !settings.administrators.length)
          )
            continue;
          const missed = expiry.due <= now || (expiry.due - lead * 1000 <= now && lead !== catchup);
          runtime.job(
            `${source}:${lead}:${role}`,
            source,
            expiry.revision,
            `expiry-${role}`,
            expiry.due - lead * 1000,
            { expiry, role, lead, settingsRevision, administrators: settings.administrators },
            missed ? 'superseded' : 'scheduled',
            missed ? 'Expired or older missed reminder; no catch-up burst.' : null,
          );
        }
    }
}
export function planRevocationFailures(runtime: SchedulerRuntime, server: string, now: number) {
  const settings = runtime.settings().expiry;
  if (!settings.enabled || !settings.administrators.length) return;
  const settingsRevision = runtime.store.get<number>('communications.settingsRevision') ?? 0;
  for (const expiry of runtime.store.all<Expiry>(
    "SELECT * FROM expiries WHERE server=? AND status IN ('pending','running','failed') AND error IS NOT NULL",
    server,
  )) {
    const source = `expiry:${expiry.server}:${expiry.user}:${expiry.revision}:settings:${settingsRevision}`;
    runtime.job(`${source}:failure`, source, expiry.revision, 'expiry-failure', now, {
      expiry,
      role: 'admin',
      settingsRevision,
      administrators: settings.administrators,
    });
  }
}
export function dispatchCommunicationJob(
  runtime: SchedulerRuntime,
  job: Job,
  snapshot: CommunicationSnapshot,
  now: number,
) {
  if (job.kind.startsWith('expiry-')) {
    dispatchExpiry(runtime, job, snapshot, now);
    return;
  }
  const row = runtime.campaign(job.source),
    p = JSON.parse(row.payload) as Payload;
  if (
    row.server !== snapshot.server.id ||
    row.revision !== job.revision ||
    row.status === 'deleted' ||
    (row.status === 'cancelled' && job.kind !== 'maintenance-change') ||
    (row.status === 'completed' && job.kind !== 'maintenance-change') ||
    (job.kind === 'maintenance' && now >= Date.parse(p.start!))
  ) {
    runtime.store.run(
      "UPDATE communication_jobs SET status='superseded',reason='Communication changed or notice is obsolete.' WHERE id=?",
      job.id,
    );
    return;
  }
  const category = row.type === 'announcement' ? 'announcement' : 'maintenance';
  const content =
    row.type === 'announcement'
      ? { subject: row.subject, body: row.body }
      : runtime.maintenanceContent(
          row,
          (JSON.parse(job.payload).change as string | undefined) ?? 'advance notice',
        );
  const audience = JSON.parse(row.audience) as AudienceMember[];
  runtime.store.transaction(() => {
    for (const email of new Set(audience.map((m) => m.email))) {
      const members = audience.filter((m) => m.email === email),
        allowed = members.filter(
          (m) => !audienceContact(runtime.store, m, category, snapshot.users, p.rule).reason,
        );
      runtime.queue.enqueue({
        key: job.id,
        kind: category,
        recipient: email,
        ...content,
        status: allowed.length ? 'pending' : 'suppressed',
        reason: allowed.length
          ? undefined
          : 'No contact in the confirmed audience remains eligible.',
        context: {
          source: 'campaign',
          campaignId: row.id,
          revision: row.revision,
          category,
          server: row.server,
          contactIds: members.map((m) => m.contactId),
          jobId: job.id,
          deadline: job.kind === 'maintenance' ? Date.parse(p.start!) : undefined,
        },
        now,
      });
    }
    runtime.store.run("UPDATE communication_jobs SET status='dispatched' WHERE id=?", job.id);
    if (row.status === 'scheduled')
      runtime.store.run(
        "UPDATE campaigns SET status='dispatched',updated=? WHERE id=?",
        now,
        row.id,
      );
    runtime.store.audit(
      'communication.dispatch',
      row.id,
      'fixed audience evaluated; individual durable messages queued',
    );
  });
}
function dispatchExpiry(
  runtime: SchedulerRuntime,
  job: Job,
  snapshot: CommunicationSnapshot,
  now: number,
) {
  const p = JSON.parse(job.payload) as {
    expiry: Expiry;
    role: string;
    lead?: number;
    settingsRevision: number;
    administrators: string[];
  };
  const current = runtime.store.one<Expiry>(
    'SELECT * FROM expiries WHERE server=? AND user=?',
    p.expiry.server,
    p.expiry.user,
  );
  const user = snapshot.users.find(
    (u) => u.id === p.expiry.user && u.kind !== 'pending' && u.libraries.length,
  );
  const failure = job.kind === 'expiry-failure';
  if (
    !current ||
    p.settingsRevision !== (runtime.store.get<number>('communications.settingsRevision') ?? 0) ||
    current.revision !== job.revision ||
    !['pending', 'running', 'failed'].includes(current.status) ||
    (!failure && (current.due <= now || !user)) ||
    (failure && !current.error) ||
    snapshot.server.id !== current.server
  ) {
    runtime.store.run(
      "UPDATE communication_jobs SET status='superseded',reason='Expiry changed, cancelled, elapsed or membership absent.' WHERE id=?",
      job.id,
    );
    return;
  }
  const settings = runtime.settings().expiry;
  const values = {
    server: snapshot.server.name,
    expires: new Date(current.due).toISOString(),
    instructions: settings.instructions,
    renewalUrl: settings.renewalUrl,
  };
  const content = failure
    ? {
        subject: 'Access revocation needs administrator attention',
        body: `Scheduled expiry ${values.expires} (UTC) for account ${current.user} on ${values.server} could not be confirmed. Access may remain. Review the administrator application; no removal is assumed.`,
      }
    : {
        subject: subjectSchema.parse(renderTemplate(settings.subject, values)),
        body: renderTemplate(settings.body, values),
      };
  const contact = contactList(runtime.store).find(
    (c) => c.server === current.server && c.user === current.user,
  );
  const recipients = p.role === 'user' ? (contact ? [contact.email] : []) : p.administrators;
  runtime.store.transaction(() => {
    for (const recipient of new Set(recipients.map((e) => e.toLowerCase()))) {
      if (
        !failure &&
        p.role === 'admin' &&
        settings.user &&
        contact?.email === recipient &&
        !contactReason(runtime.store, contact, 'expiry', true)
      )
        continue;
      const logicalKey = `expiry:${current.server}:${current.user}:${current.revision}:${failure ? 'failure' : p.lead}:${p.role}`;
      if (
        runtime.store.one(
          "SELECT id FROM deliveries WHERE recipient=? AND json_extract(context,'$.logicalKey')=? AND status IN ('sent','sending')",
          recipient,
          logicalKey,
        )
      )
        continue;
      const address = runtime.store.one<{ unsubscribed: number; blocked: string }>(
        'SELECT unsubscribed,blocked FROM addresses WHERE email=?',
        recipient,
      );
      const reason =
        p.role === 'user'
          ? contactReason(runtime.store, contact!, 'expiry', true)
          : address?.unsubscribed || JSON.parse(address?.blocked ?? '[]').includes('expiry')
            ? 'Administrator address opted out'
            : undefined;
      runtime.queue.enqueue({
        key: job.id,
        kind: failure ? 'revocation-failure' : p.role === 'user' ? 'expiry' : 'expiry-admin',
        recipient,
        ...content,
        body:
          p.role === 'admin' && !failure
            ? `${content.body}\nAdministrator reminder for account ${current.user}.`
            : content.body,
        status: reason ? 'suppressed' : 'pending',
        reason,
        context: {
          source: failure ? 'expiry-failure' : 'expiry',
          category: 'expiry',
          server: current.server,
          user: current.user,
          revision: current.revision,
          shareId: user?.shareId,
          contactId: p.role === 'user' ? contact?.id : undefined,
          personal: p.role === 'user',
          jobId: job.id,
          deadline: failure ? undefined : current.due,
          settingsRevision: p.settingsRevision,
          lead: p.lead,
          logicalKey,
        },
        now,
      });
    }
    runtime.store.run("UPDATE communication_jobs SET status='dispatched' WHERE id=?", job.id);
  });
}
