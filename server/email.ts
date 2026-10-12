import nodemailer from 'nodemailer';
import { type SmtpSettings, type MonitorSettings } from './config.js';
import { inMaintenance } from './monitor.js';
import { Store } from './store.js';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export type Delivery = {
  id: number;
  incident: string;
  kind: 'outage' | 'recovery' | 'test';
  recipient: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  next: number;
  error: string | null;
  sent: number | null;
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
  constructor(
    private store: Store,
    private sender: Sender = smtpSend,
  ) {}
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
      const rows = this.store.all<Delivery>(
        "SELECT * FROM deliveries WHERE status='pending' AND next<=? ORDER BY id LIMIT 20",
        now,
      );
      for (const row of rows) {
        const current = this.store.one<Delivery>('SELECT * FROM deliveries WHERE id=?', row.id)!;
        if (current.status !== 'pending') continue;
        const settings = this.store.get<MonitorSettings>('monitor');
        const preference = settings?.recipients.find(
          (r) => r.email.toLowerCase() === row.recipient,
        );
        if (row.kind !== 'test' && settings && (!preference || !preference[row.kind])) {
          this.store.run(
            "UPDATE deliveries SET status='suppressed',error='Recipient notification preference changed.' WHERE id=?",
            row.id,
          );
          continue;
        }
        if (
          row.kind !== 'test' &&
          settings &&
          (inMaintenance(settings, now) || settings.authority === 'external')
        ) {
          this.store.run(
            "UPDATE deliveries SET status='suppressed',error='Suppressed by maintenance or external alert authority.' WHERE id=?",
            row.id,
          );
          continue;
        }
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
            text: row.body,
            messageId: `<${row.incident}.${row.kind}.${row.id}@plex-user-manager.invalid>`,
          });
          this.store.run(
            "UPDATE deliveries SET status='sent',sent=?,error=NULL WHERE id=?",
            Date.now(),
            row.id,
          );
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
