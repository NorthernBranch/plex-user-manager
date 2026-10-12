import { guardCommunication } from './communication-delivery.js';
import { configurationDigests } from './heartbeat.js';
import {
  planCommunicationJobs,
  dispatchCommunicationJob,
  planRevocationFailures,
  type SchedulerRuntime,
} from './communication-scheduler.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { EmailQueue, type Delivery, type DeliveryContext } from './email.js';
import { AppError } from './errors.js';
import type { PlexAdapter, PlexUser, Library, SelectedServer } from './plex.js';
import { audienceSchema, recipientPreview, type AudienceMember } from './communication-audience.js';
import {
  communicationsSettingsSchema,
  defaultCommunications,
  validateTemplates,
  renderTemplate,
  subjectSchema,
  bodySchema,
  type CommunicationsSettings,
} from './communications-config.js';
import { contactList, contactReason } from './recipients.js';
import { effectiveMonitorSettings, maintenanceDigest } from './maintenance.js';

import type { Campaign, Job, Payload, Membership } from './communication-types.js';
export type { Campaign, Job } from './communication-types.js';
export const campaignInput = z
  .object({
    type: z.enum(['announcement', 'maintenance']),
    subject: subjectSchema,
    body: bodySchema,
    rule: audienceSchema,
    title: z.string().min(1).max(160).optional(),
    explanation: z.string().min(1).max(5000).optional(),
    start: z.iso.datetime().optional(),
    end: z.iso.datetime().optional(),
    leads: z
      .array(z.number().int().min(60).max(2592000))
      .max(10)
      .refine((leads) => new Set(leads).size === leads.length, 'Lead times must be unique.')
      .optional(),
    notifyChange: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (
      v.type === 'maintenance' &&
      (!v.title || !v.explanation || !v.start || !v.end || v.end <= v.start)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Maintenance requires a title, explanation and ordered UTC times.',
      });
  });

export class Communications {
  private active = false;
  private lastRefresh = 0;
  constructor(
    private store: Store,
    private queue: EmailQueue,
    private client: () => PlexAdapter,
    private selected: () => SelectedServer,
  ) {}
  settings() {
    return (
      this.store.get<CommunicationsSettings>('communications.settings') ?? defaultCommunications
    );
  }
  configure(raw: unknown) {
    const settings = communicationsSettingsSchema.parse(raw);
    validateTemplates(settings);
    const adminOrigin = this.store.get<string>('publicUrl');
    for (const link of [
      settings.welcome.requestUrl,
      settings.welcome.supportUrl,
      settings.expiry.renewalUrl,
    ])
      if (link && adminOrigin && new URL(link).hostname === new URL(adminOrigin).hostname)
        throw new AppError(
          400,
          'LINK',
          'Do not use the administrator app URL as a recipient link.',
        );
    this.store.transaction(() => {
      this.store.set('communications.settings', settings);
      this.store.set(
        'communications.settingsRevision',
        (this.store.get<number>('communications.settingsRevision') ?? 0) + 1,
      );
      this.supersedeJobs('welcome', 'Welcome settings changed.');
      this.supersedeJobs('expiry', 'Expiry reminder settings changed.');
      this.store.audit(
        'communications.configure',
        'application',
        'templates and scheduling preferences saved',
      );
    });
    return settings;
  }
  restart() {
    this.store.run("UPDATE communication_jobs SET status='scheduled' WHERE status='running'");
  }
  list() {
    const external = this.store.get<{
      at: number;
      ok: boolean;
      configurationAuthenticated?: boolean;
      workerMaintenanceDigest?: string;
      workerRecipientDigest?: string;
    }>('heartbeat.delivery');
    const digests = configurationDigests(this.store);
    const stale =
      !external?.ok ||
      Date.now() - external.at >
        Math.max(60000, effectiveMonitorSettings(this.store).intervalSeconds * 3000);
    return {
      settings: this.settings(),
      contacts: contactList(this.store),
      campaigns: this.store.all<Campaign>(
        'SELECT * FROM campaigns ORDER BY updated DESC LIMIT 200',
      ),
      jobs: this.store.all<Job>('SELECT * FROM communication_jobs ORDER BY created DESC LIMIT 300'),
      memberships: this.store.all<Membership>(
        'SELECT * FROM memberships ORDER BY observed DESC LIMIT 300',
      ),
      external: external
        ? {
            ...external,
            stale,
            maintenanceMatch:
              !stale && external.configurationAuthenticated && external.workerMaintenanceDigest
                ? external.workerMaintenanceDigest === digests.maintenance
                : null,
            recipientsMatch:
              !stale && external.configurationAuthenticated && external.workerRecipientDigest
                ? external.workerRecipientDigest === digests.recipients
                : null,
          }
        : null,
      integration: this.store.get('communications.integration') ?? null,
      maintenanceExport: this.exportMaintenance(),
    };
  }
  exportMaintenance() {
    const windows = effectiveMonitorSettings(this.store).maintenance.map(({ start, end }) => ({
      start,
      end,
    }));
    return {
      maintenance: windows,
      digest: maintenanceDigest(windows),
      instructions:
        'Copy these windows into monitor.maintenance in the external worker private configuration and restart it. This export does not synchronise settings.',
    };
  }
  private campaign(id: string) {
    const row = this.store.one<Campaign>('SELECT * FROM campaigns WHERE id=?', id);
    if (!row) throw new AppError(404, 'CAMPAIGN', 'Communication not found.');
    return row;
  }
  private stale(source: string, revision: number, reason: string) {
    this.store.run(
      "UPDATE communication_jobs SET status='superseded',reason=? WHERE source=? AND revision<>? AND status IN ('scheduled','running','failed')",
      reason,
      source,
      revision,
    );
    for (const row of this.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE context IS NOT NULL AND status IN ('pending','failed')",
    )) {
      const c = JSON.parse(row.context!) as DeliveryContext;
      if (c.campaignId === source && c.revision !== revision)
        this.store.run(
          "UPDATE deliveries SET status='superseded',error=? WHERE id=?",
          reason,
          row.id,
        );
    }
  }
  private supersedeJobs(kind: string, reason: string) {
    this.store.run(
      "UPDATE communication_jobs SET status='superseded',reason=? WHERE kind LIKE ? AND status IN ('scheduled','failed','running')",
      reason,
      `${kind}%`,
    );
    for (const row of this.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE context IS NOT NULL AND status IN ('pending','failed')",
    ))
      if ((JSON.parse(row.context!) as DeliveryContext).source === kind)
        this.store.run(
          "UPDATE deliveries SET status='superseded',error=? WHERE id=?",
          reason,
          row.id,
        );
  }
  save(id: string | undefined, raw: unknown, now = Date.now()) {
    const input = campaignInput.parse(raw),
      previous = id ? this.campaign(id) : undefined;
    if (previous && (previous.type !== input.type || previous.server !== this.selected().id))
      throw new AppError(409, 'CAMPAIGN', 'Campaign type and server cannot change.');
    if (
      previous &&
      !(
        previous.status === 'draft' ||
        (previous.type === 'maintenance' && ['scheduled', 'dispatched'].includes(previous.status))
      )
    )
      throw new AppError(
        409,
        'CAMPAIGN',
        'Only drafts or active maintenance events can be edited.',
      );
    const payload: Payload = {
      rule: input.rule,
      title: input.title,
      explanation: input.explanation,
      start: input.start,
      end: input.end,
      leads: input.leads ?? [86400, 3600],
    };
    const key = id ?? randomUUID(),
      revision = (previous?.revision ?? 0) + 1;
    if (input.type === 'maintenance')
      this.maintenanceContent(
        {
          subject: input.subject,
          body: input.body,
          payload: JSON.stringify(payload),
        },
        'advance notice',
      );
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO campaigns(id,type,server,revision,status,subject,body,payload,audience,scheduled,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,subject=excluded.subject,body=excluded.body,payload=excluded.payload,updated=excluded.updated',
        key,
        input.type,
        this.selected().id,
        revision,
        previous?.status ?? 'draft',
        input.subject,
        input.body,
        JSON.stringify(payload),
        previous?.audience ?? '[]',
        previous?.scheduled ?? null,
        previous?.created ?? now,
        now,
      );
      this.stale(key, revision, 'Maintenance event edited; earlier notices obsolete.');
      this.store.audit('communication.save', key, 'saved');
      if (previous && previous.status !== 'draft' && input.notifyChange)
        this.job(`${key}:${revision}:rescheduled`, key, revision, 'maintenance-change', now, {
          change: 'rescheduled or extended',
        });
    });
    return this.campaign(key);
  }
  remove(id: string) {
    const row = this.campaign(id);
    if (row.status !== 'draft')
      throw new AppError(
        409,
        'CAMPAIGN',
        'Only drafts can be deleted. Cancel a scheduled message instead.',
      );
    this.store.run("UPDATE campaigns SET status='deleted',updated=? WHERE id=?", Date.now(), id);
    this.store.audit('communication.delete', id, 'draft retained in history');
  }
  async snapshot() {
    const server = this.selected();
    const adapter = this.client();
    const [users, libraries] = await Promise.all([
      adapter.users(server.id),
      adapter.libraries(server.id),
    ]);
    if (this.selected().id !== server.id)
      throw new AppError(409, 'SERVER', 'Selected server changed during the request. Retry.');
    return { server, users, libraries };
  }
  async preview(id: string, now = Date.now()) {
    const row = this.campaign(id),
      snapshot = await this.snapshot();
    if (row.server !== snapshot.server.id)
      throw new AppError(409, 'SERVER', 'Select this communication’s server.');
    const p = JSON.parse(row.payload) as Payload;
    const audience = recipientPreview(
      this.store,
      row.server,
      snapshot.users,
      p.rule,
      row.type === 'announcement' ? 'announcement' : 'maintenance',
    );
    const content =
      row.type === 'announcement'
        ? { subject: row.subject, body: row.body }
        : this.maintenanceContent(row, 'advance notice');
    const ticket = randomUUID();
    this.store.set(`communication-preview:${ticket}`, {
      id,
      revision: row.revision,
      expires: now + 300000,
      audience: audience.included,
    });
    return { ticket, ...audience, ...content, server: snapshot.server.name };
  }
  confirm(
    id: string,
    ticket: string,
    scheduled: number | null,
    confirm: boolean,
    now = Date.now(),
  ) {
    if (!confirm) throw new AppError(400, 'CONFIRM', 'Confirm the displayed content and audience.');
    const row = this.campaign(id),
      plan = this.store.get<{
        id: string;
        revision: number;
        expires: number;
        audience: AudienceMember[];
      }>(`communication-preview:${ticket}`);
    if (
      row.status !== 'draft' ||
      !plan ||
      plan.id !== id ||
      plan.revision !== row.revision ||
      plan.expires < now ||
      (!plan.audience.length && row.type === 'announcement')
    )
      throw new AppError(409, 'PREVIEW', 'Preview missing, stale or empty. Preview again.');
    if (row.server !== this.selected().id)
      throw new AppError(409, 'SERVER', 'Select the reviewed server.');
    const due = scheduled ?? now;
    if (scheduled !== null && scheduled < now)
      throw new AppError(400, 'SCHEDULE', 'Scheduled time must be in the future.');
    this.store.transaction(() => {
      this.store.run(
        "UPDATE campaigns SET status='scheduled',scheduled=?,audience=?,updated=? WHERE id=?",
        due,
        JSON.stringify(plan.audience),
        now,
        id,
      );
      this.store.run('DELETE FROM kv WHERE key=?', `communication-preview:${ticket}`);
      if (row.type === 'announcement')
        this.job(`${id}:${row.revision}:announcement`, id, row.revision, 'announcement', due, {});
      this.store.audit('communication.confirm', id, 'fixed audience confirmed; UTC schedule saved');
    });
    return this.campaign(id);
  }
  action(
    id: string,
    action: 'cancel' | 'complete',
    notify: boolean,
    confirm: boolean,
    now = Date.now(),
  ) {
    if (!confirm) throw new AppError(400, 'CONFIRM', 'Confirm the event action.');
    const row = this.campaign(id);
    if (
      row.server !== this.selected().id ||
      !['scheduled', 'dispatched'].includes(row.status) ||
      (action === 'complete' && row.type !== 'maintenance')
    )
      throw new AppError(409, 'CAMPAIGN', 'This communication cannot take that action.');
    const revision = row.revision + 1;
    this.store.transaction(() => {
      this.store.run(
        'UPDATE campaigns SET status=?,revision=?,updated=? WHERE id=?',
        action === 'cancel' ? 'cancelled' : 'completed',
        revision,
        now,
        id,
      );
      this.stale(id, revision, `Event ${action}; older jobs superseded.`);
      if (notify && row.type === 'maintenance')
        this.job(`${id}:${revision}:${action}`, id, revision, 'maintenance-change', now, {
          change: action === 'complete' ? 'completed explicitly by administrator' : 'cancelled',
        });
      this.store.audit(`communication.${action}`, id, 'explicit administrator action');
    });
    return this.campaign(id);
  }
  testCampaign(id: string, recipient: string) {
    const row = this.campaign(id);
    if (row.server !== this.selected().id)
      throw new AppError(409, 'SERVER', 'Select this communication’s server before testing.');
    const content =
      row.type === 'announcement'
        ? { subject: row.subject, body: row.body }
        : this.maintenanceContent(row, 'test preview');
    return this.queue.enqueue({ key: randomUUID(), kind: 'test', recipient, ...content });
  }
  private maintenanceContent(row: Pick<Campaign, 'subject' | 'body' | 'payload'>, change: string) {
    const p = JSON.parse(row.payload) as Payload,
      name = this.selected().name;
    const values = {
      title: p.title ?? '',
      explanation: p.explanation ?? '',
      server: name,
      start: p.start ?? '',
      end: p.end ?? '',
      change,
    };
    return {
      subject: subjectSchema.parse(renderTemplate(row.subject, values)),
      body: renderTemplate(row.body, values),
    };
  }
  private job(
    id: string,
    source: string,
    revision: number,
    kind: string,
    due: number,
    payload: unknown,
    status = 'scheduled',
    reason: string | null = null,
  ) {
    this.store.run(
      'INSERT OR IGNORE INTO communication_jobs(id,source,revision,kind,due,status,payload,reason,created) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      source,
      revision,
      kind,
      due,
      status,
      JSON.stringify(payload),
      reason,
      Date.now(),
    );
    if (status === 'superseded')
      this.store.run(
        "UPDATE communication_jobs SET status='superseded',reason=? WHERE id=? AND status IN ('scheduled','running','failed')",
        reason,
        id,
      );
  }
  retryJob(id: string) {
    const job = this.store.one<Job>('SELECT * FROM communication_jobs WHERE id=?', id);
    if (!job || job.status !== 'failed')
      throw new AppError(409, 'JOB', 'Only failed dispatch jobs can be retried.');
    this.store.run(
      "UPDATE communication_jobs SET status='scheduled',attempts=0,next=0 WHERE id=?",
      id,
    );
    this.store.audit('communication.retry', id, 'dispatch retry requested');
  }
  invalidateExpiry(server: string, user: string) {
    this.store.run(
      "UPDATE communication_jobs SET status='superseded',reason='Expiry changed or cancelled.' WHERE kind LIKE 'expiry-%' AND json_extract(payload,'$.expiry.server')=? AND json_extract(payload,'$.expiry.user')=? AND status IN ('scheduled','running','failed')",
      server,
      user,
    );
    this.store.run(
      "UPDATE deliveries SET status='superseded',error='Expiry changed or cancelled.' WHERE json_extract(context,'$.server')=? AND json_extract(context,'$.user')=? AND json_extract(context,'$.source') IN ('expiry','expiry-failure') AND status IN ('pending','failed')",
      server,
      user,
    );
  }
  observe(server: string, users: PlexUser[], now = Date.now()) {
    this.store.transaction(() => {
      const known = this.store.all<Membership>('SELECT * FROM memberships WHERE server=?', server);
      for (const old of known)
        if (!users.some((u) => u.shareId === old.share_id && u.id === old.user))
          this.store.run(
            "UPDATE memberships SET status='absent',observed=? WHERE server=? AND share_id=?",
            now,
            server,
            old.share_id,
          );
      for (const user of users) {
        const old = known.find((m) => m.share_id === user.shareId && m.user === user.id);
        const generation = (old?.generation ?? 1) + (old?.status === 'absent' ? 1 : 0);
        const accepted =
          old?.status === 'pending' && user.kind === 'shared' && user.libraries.length > 0;
        const welcome = accepted
          ? this.settings().welcome.enabled
            ? 'eligible'
            : 'manual'
          : old?.status === 'absent'
            ? 'baseline'
            : (old?.welcome ?? 'baseline');
        this.store.run(
          'INSERT INTO memberships(server,user,share_id,kind,status,generation,welcome,observed) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server,share_id) DO UPDATE SET user=excluded.user,kind=excluded.kind,status=excluded.status,generation=excluded.generation,welcome=excluded.welcome,observed=excluded.observed',
          server,
          user.id,
          user.shareId,
          user.kind,
          user.kind === 'pending' ? 'pending' : 'active',
          generation,
          welcome,
          now,
        );
      }
    });
  }
  private welcomeContent(user: PlexUser, libraries: Library[]) {
    const settings = this.settings().welcome;
    const values = {
      server: this.selected().name,
      libraries: user.libraries
        .map((id) => libraries.find((l) => l.id === id)?.title ?? 'Unavailable library')
        .join(', '),
      gettingStarted: settings.gettingStarted,
      rules: settings.rules,
      requestUrl: settings.requestUrl,
      supportUrl: settings.supportUrl,
    };
    return {
      subject: subjectSchema.parse(renderTemplate(settings.subject, values)),
      body: renderTemplate(settings.body, values),
    };
  }
  async welcomePreview(userId: string) {
    const s = await this.snapshot();
    const user = s.users.find((u) => u.id === userId && u.kind !== 'pending' && u.libraries.length);
    if (!user) throw new AppError(409, 'MEMBERSHIP', 'Confirmed server access is required.');
    return this.welcomeContent(user, s.libraries);
  }
  async welcome(userId: string, requestId: string, confirm: boolean, now = Date.now()) {
    if (!confirm) throw new AppError(400, 'CONFIRM', 'Confirm this explicit welcome send/resend.');
    const s = await this.snapshot(),
      user = s.users.find((u) => u.id === userId && u.kind !== 'pending' && u.libraries.length);
    if (!user)
      throw new AppError(
        409,
        'MEMBERSHIP',
        'Confirmed access is required; pending invitations are not welcomed.',
      );
    this.observe(s.server.id, s.users, now);
    const member = this.store.one<Membership>(
      'SELECT * FROM memberships WHERE server=? AND share_id=?',
      s.server.id,
      user.shareId,
    )!;
    const contact = contactList(this.store).find(
      (c) => c.server === s.server.id && c.user === userId,
    );
    if (!contact || contactReason(this.store, contact, 'welcome', true))
      throw new AppError(
        409,
        'CONTACT',
        'A verified, opted-in contact without an ambiguous shared address is required.',
      );
    this.enqueueWelcome(
      user,
      s.libraries,
      member,
      contact.id,
      `${s.server.id}:${user.shareId}:${member.generation}:manual:${requestId}`,
      now,
    );
    this.store.audit(
      'welcome.manual',
      userId,
      'explicit welcome queued; no invitation acceptance inferred',
    );
    return { status: 'queued' };
  }
  private enqueueWelcome(
    user: PlexUser,
    libraries: Library[],
    member: Membership,
    contactId: string,
    key: string,
    now: number,
  ) {
    const c = contactList(this.store).find((c) => c.id === contactId)!;
    this.queue.enqueue({
      key: `welcome:${key}`,
      kind: 'welcome',
      recipient: c.email,
      ...this.welcomeContent(user, libraries),
      context: {
        source: 'welcome',
        category: 'welcome',
        contactId,
        revision: c.revision,
        server: member.server,
        user: user.id,
        shareId: user.shareId,
        generation: member.generation,
        personal: true,
      },
      now,
    });
  }
  private schedulingRuntime(): SchedulerRuntime {
    return {
      store: this.store,
      queue: this.queue,
      settings: () => this.settings(),
      campaign: (id) => this.campaign(id),
      maintenanceContent: (row, change) => this.maintenanceContent(row, change),
      job: (...args) => this.job(...args),
      enqueueWelcome: (...args) => this.enqueueWelcome(...args),
    };
  }
  async tick(now = Date.now()) {
    if (this.active) return;
    this.active = true;
    try {
      if (!this.store.getSecret('server')) return;
      planRevocationFailures(this.schedulingRuntime(), this.selected().id, now);
      let snapshot: Awaited<ReturnType<Communications['snapshot']>> | undefined;
      if (now - this.lastRefresh >= 30000 || this.lastRefresh === 0) {
        try {
          snapshot = await this.snapshot();
          this.observe(snapshot.server.id, snapshot.users, now);
          planCommunicationJobs(this.schedulingRuntime(), snapshot, now);
          this.lastRefresh = now;
          this.store.set('communications.integration', { at: now, ok: true });
        } catch {
          this.store.set('communications.integration', { at: now, ok: false });
          // Due jobs still get bounded dispatch retries; malformed Plex evidence is never absence.
        }
      }
      const jobs = this.store.all<Job>(
        "SELECT * FROM communication_jobs WHERE status='scheduled' AND due<=? AND next<=? ORDER BY due DESC LIMIT 10",
        now,
        now,
      );
      for (const job of jobs) {
        this.store.run(
          "UPDATE communication_jobs SET status='running' WHERE id=? AND status='scheduled'",
          job.id,
        );
        try {
          const evidence =
            job.kind === 'expiry-failure'
              ? { server: this.selected(), users: [], libraries: [] }
              : (snapshot ?? (snapshot = await this.snapshot()));
          dispatchCommunicationJob(this.schedulingRuntime(), job, evidence, now);
        } catch {
          const attempts = job.attempts + 1;
          this.store.run(
            "UPDATE communication_jobs SET status=?,attempts=?,next=?,reason=? WHERE id=? AND status='running'",
            attempts >= 5 ? 'failed' : 'scheduled',
            attempts,
            now + Math.min(3600000, 30000 * 2 ** attempts),
            'Dispatch unavailable; no successful delivery is assumed.',
            job.id,
          );
        }
      }
    } finally {
      this.active = false;
    }
  }
  deliveryGuard(row: Delivery, now: number) {
    return guardCommunication(
      {
        store: this.store,
        settings: () => this.settings(),
        snapshot: () => this.snapshot(),
        campaign: (id) => this.campaign(id),
      },
      row,
      now,
    );
  }
}
