import nodemailer from 'nodemailer';
import { type SmtpSettings } from './config.js';
import { inMaintenance } from './monitor.js';
import { Store } from './store.js';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { seal, unseal, hash } from './crypto.js';
import { effectiveMonitorSettings } from './maintenance.js';
import { notificationRecipients } from './recipients.js';

export type Delivery = {
  id: number;
  incident: string;
  kind:
    | 'outage'
    | 'recovery'
    | 'test'
    | 'announcement'
    | 'maintenance'
    | 'welcome'
    | 'expiry'
    | 'expiry-admin'
    | 'revocation-failure'
    | 'verification'
    | 'preference-link';
  recipient: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  next: number;
  error: string | null;
  sent: number | null;
  context: string | null;
  private_body: string | null;
};
export type DeliveryContext = {
  source: string;
  contactId?: string;
  revision?: number;
  tokenHash?: string;
  server?: string;
  user?: string;
  shareId?: string;
  generation?: number;
  campaignId?: string;
  category?: string;
  personal?: boolean;
  contactIds?: string[];
  deadline?: number;
  jobId?: string;
  settingsRevision?: number;
  logicalKey?: string;
  lead?: number;
};
export type Sender = (
  config: SmtpSettings,
  message: { to: string; subject: string; text: string; messageId: string },
) => Promise<void>;
export const smtpSend: Sender = async (config, message) => {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === 'implicit',
    requireTLS: config.tls === 'starttls',
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      messageId: message.messageId,
    });
  } finally {
    transport.close();
  }
};
export class EmailQueue {
  private active = false;
  private guard?: (delivery: Delivery, now: number) => Promise<string | undefined>;
  constructor(
    private store: Store,
    private sender: Sender = smtpSend,
  ) {}
  setGuard(guard: (delivery: Delivery, now: number) => Promise<string | undefined>) {
    this.guard = guard;
  }
  enqueue(input: {
    key: string;
    kind: Delivery['kind'];
    recipient: string;
    subject: string;
    body: string;
    context?: DeliveryContext;
    private?: boolean;
    now?: number;
    status?: string;
    reason?: string;
  }) {
    if (/[\r\n]/.test(input.subject))
      throw new AppError(400, 'HEADER', 'Email subject cannot contain line breaks.');
    this.store.run(
      'INSERT OR IGNORE INTO deliveries(incident,kind,recipient,subject,body,status,next,context,private_body,error) VALUES(?,?,?,?,?,?,?,?,?,?)',
      input.key,
      input.kind,
      input.recipient.toLowerCase(),
      input.subject,
      input.private ? '' : input.body,
      input.status ?? 'pending',
      input.now ?? Date.now(),
      input.context ? JSON.stringify(input.context) : null,
      input.private ? seal(input.body, this.store.key) : null,
      input.reason ?? null,
    );
    return this.store.one<{ id: number }>(
      'SELECT id FROM deliveries WHERE incident=? AND kind=? AND recipient=?',
      input.key,
      input.kind,
      input.recipient.toLowerCase(),
    )!.id;
  }
  restart(now = Date.now()) {
    // SMTP acceptance may have occurred before a crash. Retry with stable Message-ID; duplicates remain possible.
    this.store.run(
      "UPDATE deliveries SET status='pending',next=?,error='Interrupted SMTP delivery; acceptance is unknown.' WHERE status='sending'",
      now,
    );
    this.store.run(
      "UPDATE deliveries SET status='superseded' WHERE kind='outage' AND status='pending' AND EXISTS(SELECT 1 FROM incidents i WHERE i.id=deliveries.incident AND i.recovered IS NOT NULL)",
    );
  }
  test(recipient: string) {
    const id = randomUUID();
    this.store.run(
      'INSERT INTO deliveries(incident,kind,recipient,subject,body,status,next) VALUES(?,?,?,?,?,?,?)',
      id,
      'test',
      recipient,
      'Plex User Manager SMTP test',
      'This is a requested SMTP test.',
      'pending',
      Date.now(),
    );
    return id;
  }
  async drain(now = Date.now()) {
    if (this.active) return;
    const config = this.store.getSecret<SmtpSettings>('smtp');
    if (!config) return;
    this.active = true;
    try {
      const batch =
        this.store.get<{ batchSize: number }>('communications.settings')?.batchSize ?? 5;
      const rows = this.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE status='pending' AND next<=? ORDER BY id LIMIT ?",
        now,
        Math.min(20, Math.max(1, batch)),
      );
      for (const row of rows) {
        const current = this.store.one<Delivery>('SELECT * FROM deliveries WHERE id=?', row.id)!;
        if (current.status !== 'pending') continue;
        const settings = effectiveMonitorSettings(this.store);
        const incidentMessage = row.kind === 'outage' || row.kind === 'recovery';
        const selected = this.store.getSecret<{ id: string }>('server');
        const preference = notificationRecipients(this.store, settings, selected?.id).find(
          (r) => r.email.toLowerCase() === row.recipient,
        );
        if (incidentMessage && (!preference || !preference[row.kind as 'outage' | 'recovery'])) {
          this.store.run(
            "UPDATE deliveries SET status='suppressed',error='Recipient notification preference changed.' WHERE id=?",
            row.id,
          );
          continue;
        }
        if (
          incidentMessage &&
          (inMaintenance(settings, now) || settings.authority === 'external')
        ) {
          this.store.run(
            "UPDATE deliveries SET status='suppressed',error='Suppressed by maintenance or external alert authority.' WHERE id=?",
            row.id,
          );
          continue;
        }
        try {
          const reason = this.guard && row.kind !== 'test' ? await this.guard(row, now) : undefined;
          if (reason) {
            this.store.run(
              "UPDATE deliveries SET status='suppressed',error=? WHERE id=? AND status='pending'",
              reason,
              row.id,
            );
            continue;
          }
        } catch {
          const attempts = row.attempts + 1;
          this.store.run(
            "UPDATE deliveries SET status=?,attempts=?,next=?,error=? WHERE id=? AND status='pending'",
            attempts >= 5 ? 'failed' : 'pending',
            attempts,
            now + Math.min(3600000, 30000 * 2 ** attempts),
            'Eligibility check unavailable; no SMTP send attempted.',
            row.id,
          );
          continue;
        }
        if (
          this.store.one<{ status: string }>('SELECT status FROM deliveries WHERE id=?', row.id)
            ?.status !== 'pending'
        )
          continue;
        if (row.kind === 'recovery') {
          const outage = this.store.one<Delivery>(
            "SELECT * FROM deliveries WHERE incident=? AND recipient=? AND kind='outage'",
            row.incident,
            row.recipient,
          );
          if (outage?.status === 'sending' || outage?.status === 'pending') continue;
          if (outage?.status !== 'sent' && preference?.outage !== false) {
            this.store.run(
              "UPDATE deliveries SET status='suppressed',error='No delivered outage.' WHERE id=?",
              row.id,
            );
            continue;
          }
        }
        this.store.run(
          "UPDATE deliveries SET status='sending',attempts=attempts+1 WHERE id=?",
          row.id,
        );
        try {
          await this.sender(config, {
            to: row.recipient,
            subject: row.subject,
            text: row.private_body ? unseal<string>(row.private_body, this.store.key) : row.body,
            messageId: `<${hash(row.incident)}.${row.kind}.${row.id}@plex-user-manager.invalid>`,
          });
          this.store.run(
            "UPDATE deliveries SET status='sent',sent=?,error=NULL WHERE id=?",
            Date.now(),
            row.id,
          );
          if (row.context) {
            const c = JSON.parse(row.context) as DeliveryContext;
            if (c.source === 'welcome')
              this.store.run(
                "UPDATE memberships SET welcome='sent' WHERE server=? AND share_id=? AND generation=?",
                c.server!,
                c.shareId!,
                c.generation!,
              );
          }
        } catch {
          const recovered =
            row.kind === 'outage' &&
            this.store.one<{ recovered: number | null }>(
              'SELECT recovered FROM incidents WHERE id=?',
              row.incident,
            )?.recovered;
          const attempts = row.attempts + 1;
          this.store.run(
            'UPDATE deliveries SET status=?,next=?,error=? WHERE id=?',
            recovered ? 'superseded' : attempts >= 5 ? 'failed' : 'pending',
            now + Math.min(3600000, 30000 * 2 ** attempts),
            'SMTP delivery failed. Check TLS, authentication and connectivity; remote acceptance may be unknown.',
            row.id,
          );
        }
      }
    } finally {
      this.active = false;
    }
  }
  retry(id: number) {
    const row = this.store.one<Delivery>('SELECT * FROM deliveries WHERE id=?', id);
    if (!row || row.status !== 'failed')
      throw new AppError(409, 'DELIVERY', 'Only failed messages can be retried.');
    if (
      row.kind === 'outage' &&
      this.store.one<{ recovered: number | null }>(
        'SELECT recovered FROM incidents WHERE id=?',
        row.incident,
      )?.recovered
    )
      throw new AppError(409, 'STALE', 'Recovered incident: this outage message is stale.');
    this.store.run(
      "UPDATE deliveries SET status='pending',attempts=0,next=? WHERE id=?",
      Date.now(),
      id,
    );
  }
}
