import { describe, it, expect, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { EmailQueue, smtpSend, type Delivery, type Sender } from '../server/email.js';
import { Monitor } from '../server/monitor.js';
import { memory, monitorSettings, testSmtp } from './helpers.js';
import type { AddressInfo } from 'node:net';

function fixture(sender: Sender) {
  const db = memory();
  db.set('monitor', monitorSettings());
  db.setSecret('smtp', testSmtp);
  const monitor = new Monitor(db);
  for (const t of [0, 5000, 10000, 15000]) monitor.observe(false, t);
  return { db, monitor, queue: new EmailQueue(db, sender) };
}
describe('durable email queue', () => {
  it('honours recovery-only preferences without a preceding outage email', async () => {
    const db = memory(),
      sender = vi.fn<Sender>().mockResolvedValue();
    db.set(
      'monitor',
      monitorSettings({
        recipients: [{ email: 'one@example.com', outage: false, recovery: true }],
      }),
    );
    db.setSecret('smtp', testSmtp);
    const m = new Monitor(db);
    for (const t of [0, 5000, 10000, 15000]) m.observe(false, t);
    m.observe(true, 20000);
    m.observe(true, 25000);
    await new EmailQueue(db, sender).drain(30000);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][1].subject).toBe('Plex availability recovered');
    db.close();
  });
  it('suppresses queued mail after a recipient opts out', async () => {
    const sender = vi.fn<Sender>().mockResolvedValue(),
      { db, queue } = fixture(sender);
    db.set(
      'monitor',
      monitorSettings({ recipients: [{ email: 'two@example.com', outage: true, recovery: true }] }),
    );
    await queue.drain(20000);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][1].to).toBe('two@example.com');
    db.close();
  });
  it('requires TLS verification and blocks attachment URL/file access', async () => {
    const spy = vi
      .spyOn(nodemailer, 'createTransport')
      .mockImplementation(
        () =>
          ({ sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() }) as unknown as ReturnType<
            typeof nodemailer.createTransport
          >,
      );
    try {
      for (const tls of ['implicit', 'starttls'] as const) {
        await smtpSend(
          { ...testSmtp, tls },
          {
            to: 'synthetic@example.com',
            subject: 'Synthetic test',
            text: 'Synthetic',
            messageId: '<test@plex-user-manager.invalid>',
          },
        );
        expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({
          secure: tls === 'implicit',
          requireTLS: tls === 'starttls',
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      }
    } finally {
      spy.mockRestore();
    }
  });
  it('suppresses queued notifications that reach delivery during maintenance', async () => {
    const sender = vi.fn<Sender>().mockResolvedValue(),
      { db, queue } = fixture(sender);
    db.set(
      'monitor',
      monitorSettings({
        maintenance: [{ start: '1970-01-01T00:00:20.000Z', end: '1970-01-01T00:01:00.000Z' }],
      }),
    );
    await queue.drain(20000);
    await queue.drain(60000);
    expect(sender).not.toHaveBeenCalled();
    expect(
      db.all<Delivery>('SELECT * FROM deliveries').every((d) => d.status === 'suppressed'),
    ).toBe(true);
    db.close();
  });
  it('delivers separately per recipient through a local test SMTP service', async () => {
    const envelopes: { to: string[]; text: string }[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        let text = '';
        stream.on('data', (chunk) => {
          text += chunk.toString();
        });
        stream.on('end', () => {
          envelopes.push({ to: session.envelope.rcptTo.map((r) => r.address), text });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.server.address() as AddressInfo).port;
    const sender: Sender = async (config, message) => {
      const transport = nodemailer.createTransport({
        host: '127.0.0.1',
        port,
        secure: false,
        ignoreTLS: true,
      });
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
      });
      transport.close();
    };
    const { db, queue } = fixture(sender);
    try {
      await queue.drain(20000);
      expect(envelopes).toHaveLength(2);
      expect(envelopes.map((e) => e.to)).toEqual([['one@example.com'], ['two@example.com']]);
      expect(envelopes[0].text).not.toContain('two@example.com');
      expect(envelopes[1].text).not.toContain('one@example.com');
      expect(db.all<Delivery>('SELECT * FROM deliveries').every((d) => d.status === 'sent')).toBe(
        true,
      );
    } finally {
      db.close();
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });
  it('bounds retries, preserves Message-ID and shows terminal failures', async () => {
    const sender = vi
      .fn<Sender>()
      .mockRejectedValue(new Error('synthetic sensitive SMTP diagnostic'));
    const { db, queue } = fixture(sender);
    for (const t of [20000, 100000, 300000, 1000000, 4000000]) await queue.drain(t);
    expect(
      db
        .all<Delivery>('SELECT * FROM deliveries')
        .every((d) => d.status === 'failed' && d.attempts === 5),
    ).toBe(true);
    await queue.drain(10000000);
    expect(sender).toHaveBeenCalledTimes(10);
    expect(sender.mock.calls[0][1].messageId).toBe(sender.mock.calls[2][1].messageId);
    expect(db.all<Delivery>('SELECT * FROM deliveries')[0].error).not.toContain(
      'synthetic sensitive',
    );
    db.close();
  });
  it('recovers interrupted delivery after process restart without duplicate queue entries', async () => {
    const { db, queue } = fixture(vi.fn<Sender>().mockResolvedValue());
    db.run("UPDATE deliveries SET status='sending'");
    new EmailQueue(db).restart(20000);
    await queue.drain(20000);
    expect(db.all<Delivery>('SELECT * FROM deliveries').every((d) => d.status === 'sent')).toBe(
      true,
    );
    expect(db.all('SELECT * FROM deliveries')).toHaveLength(2);
    db.close();
  });
  it('does not send stale outage or misleading recovery when outage delivery failed', async () => {
    const sender = vi.fn<Sender>().mockRejectedValue(new Error('failure'));
    const { db, monitor, queue } = fixture(sender);
    await queue.drain(20000);
    monitor.observe(true, 20000);
    monitor.observe(true, 25000);
    sender.mockResolvedValue();
    await queue.drain(100000);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(
      db
        .all<Delivery>('SELECT * FROM deliveries')
        .every((d) => d.status === 'superseded' || d.status === 'suppressed'),
    ).toBe(true);
    db.close();
  });
  it('lets accepted in-flight outage finish before sending its recovery', async () => {
    let release: () => void = () => {};
    const sender = vi
      .fn<Sender>()
      .mockImplementationOnce(
        async () =>
          new Promise<void>((r) => {
            release = r;
          }),
      )
      .mockResolvedValue();
    const { db, monitor, queue } = fixture(sender);
    const first = queue.drain(20000);
    monitor.observe(true, 20000);
    monitor.observe(true, 25000);
    await queue.drain(30000);
    release();
    await first;
    await queue.drain(30000);
    expect(sender.mock.calls.map((c) => c[1].subject)).toEqual([
      'Plex availability outage',
      'Plex availability recovered',
    ]);
    db.close();
  });
});
