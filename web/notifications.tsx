import { useEffect, useState } from 'react';
import { api } from './api';
import { Badge, Card, Field } from './components';
import type { Notice, Settings, DeliverySummary } from './types';
export function Notifications({
  settings,
  refresh,
  notice,
  offline,
}: {
  settings: Settings;
  refresh: () => Promise<void>;
  notice: Notice;
  offline: boolean;
}) {
  const [deliveries, setDeliveries] = useState<DeliverySummary[]>([]),
    [busy, setBusy] = useState(false);
  async function history() {
    try {
      setDeliveries(await api('/deliveries'));
    } catch (e) {
      notice((e as Error).message);
    }
  }
  useEffect(() => {
    void history();
    const timer = setInterval(() => void history(), 10000);
    return () => clearInterval(timer);
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      await history();
    } catch (e) {
      notice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">DELIVERY</p>
          <h1>Notifications</h1>
          <p>Durable queue · Individual messages · Visible delivery status</p>
        </div>
        <button className="secondary" onClick={() => void history()}>
          Refresh history
        </button>
      </div>
      <div className="grid two">
        <Card title="3. Configure SMTP (optional)">
          <form
            key={settings.smtp?.host}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api(
                  '/smtp',
                  {
                    host: f.get('host'),
                    port: Number(f.get('port')),
                    tls: f.get('tls'),
                    username: f.get('username'),
                    password: f.get('password'),
                    from: f.get('from'),
                  },
                  'PUT',
                );
                notice('SMTP configuration saved. Send a test next.');
              });
            }}
          >
            <Field label="SMTP host">
              <input
                name="host"
                defaultValue={settings.smtp?.host ?? ''}
                placeholder="smtp.example.com"
                required
              />
            </Field>
            <Field label="SMTP port">
              <input
                name="port"
                type="number"
                defaultValue={settings.smtp?.port ?? 587}
                min={1}
                max={65535}
                required
              />
            </Field>
            <Field label="TLS mode">
              <select name="tls" defaultValue={settings.smtp?.tls ?? 'starttls'}>
                <option value="starttls">Required STARTTLS (usually 587)</option>
                <option value="implicit">Implicit TLS (usually 465)</option>
              </select>
            </Field>
            <Field label="SMTP username">
              <input
                name="username"
                defaultValue={settings.smtp?.username ?? ''}
                autoComplete="off"
              />
            </Field>
            <Field
              label="SMTP password"
              hint={
                settings.smtp?.hasPassword
                  ? 'Leave blank to retain the encrypted password.'
                  : 'Required when a username is provided.'
              }
            >
              <input name="password" type="password" autoComplete="new-password" />
            </Field>
            <Field label="Sender address">
              <input
                name="from"
                type="email"
                defaultValue={settings.smtp?.from ?? ''}
                placeholder="alerts@example.com"
                required
              />
            </Field>
            <button disabled={offline || busy}>Save SMTP configuration</button>
          </form>
        </Card>
        <Card title="Test delivery">
          <p>
            A test is queued for one address. Check the delivery history for SMTP acceptance or a
            visible failure.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api('/smtp/test', { recipient: f.get('recipient') });
                notice('Test queued. Refresh history to see delivery status.');
              });
            }}
          >
            <Field label="Test recipient">
              <input type="email" name="recipient" required placeholder="admin@example.com" />
            </Field>
            <button className="secondary" disabled={offline || busy || !settings.smtp}>
              Queue test email
            </button>
          </form>
          <p className="muted">
            SMTP cannot guarantee exactly-once delivery when the connection fails after acceptance.
            Retries use a stable Message-ID, but a recipient can still see duplicates.
          </p>
          <p>
            Recipients and notification preferences are configured in Monitoring. Plex email
            addresses are never used automatically.
          </p>
          <p>
            Outage messages still queued when an incident recovers are superseded. Recovery is sent
            after an accepted outage, or when the recipient explicitly opted for recovery-only
            alerts.
          </p>
        </Card>
      </div>
      <Card title="Delivery history">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{d.recipient}</td>
                  <td>{d.kind}</td>
                  <td>
                    <Badge
                      tone={
                        d.status === 'sent' ? 'good' : d.status === 'failed' ? 'bad' : 'neutral'
                      }
                    >
                      {d.status === 'sent'
                        ? 'SMTP accepted'
                        : d.status === 'pending'
                          ? 'Queued'
                          : d.status}
                    </Badge>
                  </td>
                  <td>{d.attempts}</td>
                  <td>
                    {d.error ?? (d.sent ? new Date(d.sent).toLocaleString() : 'Queued')}
                    {d.status === 'failed' && (
                      <button
                        className="text-button"
                        disabled={offline || busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`/deliveries/${d.id}/retry`, {});
                          })
                        }
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.length && <p className="empty">No notifications have been queued.</p>}
        </div>
      </Card>
    </>
  );
}
