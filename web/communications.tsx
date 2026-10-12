import { useEffect, useState } from 'react';
import { api } from './api';
import { Badge, Card, JsonHistory } from './components';
import { ContactEditor } from './contact-editor';
import { CommunicationSettings } from './communications-settings';
import { CampaignEditor } from './campaign-editor';
import type { Campaign, Job } from '../server/communications';
import type { CommunicationsSettings } from '../server/communications-config';
import type { Contact } from '../server/recipients';
import type { Snapshot, DeliverySummary, Notice, Settings } from './types';
type Data = {
  settings: CommunicationsSettings;
  contacts: Contact[];
  campaigns: Campaign[];
  jobs: Job[];
  memberships: {
    server: string;
    user: string;
    share_id: string;
    welcome: string;
    status: string;
  }[];
  maintenanceExport: {
    maintenance: { start: string; end: string }[];
    digest: string;
    instructions: string;
  };
  external: Settings['heartbeatDelivery'];
  integration?: { at: number; ok: boolean } | null;
};
export function CommunicationsSummary({ open }: { open: () => void }) {
  const [data, setData] = useState<Data>();
  const [history, setHistory] = useState<DeliverySummary[]>([]);
  useEffect(() => {
    void api<Data>('/communications')
      .then(setData)
      .catch(() => {});
    void api<DeliverySummary[]>('/communications/history')
      .then(setHistory)
      .catch(() => {});
  }, []);
  const events = (data?.campaigns ?? []).filter(
    (row) => row.type === 'maintenance' && ['scheduled', 'dispatched'].includes(row.status),
  );
  return (
    <Card title="Maintenance & communications">
      {events.slice(0, 3).map((row) => {
        const payload = JSON.parse(row.payload) as { title: string; start: string; end: string };
        return (
          <p key={row.id}>
            <strong>{payload.title}</strong>
            <br />
            {payload.start} to {payload.end} (UTC) · {row.status}
          </p>
        );
      })}
      {!events.length && <p>No scheduled maintenance events.</p>}
      <p>
        {(data?.jobs ?? []).filter((job) => job.status === 'failed').length} failed dispatch jobs.
        Monitoring and delivery run on the backend while this PWA is closed.
      </p>
      <button className="secondary" onClick={open}>
        Open communications
      </button>
      {!!history.length && (
        <JsonHistory
          items={history.slice(0, 4).map((row) => ({
            ...row,
            status:
              row.status === 'sent'
                ? 'SMTP accepted'
                : row.status === 'pending'
                  ? 'Queued'
                  : row.status,
          }))}
          columns={[
            { key: 'kind', label: 'Recent notification' },
            { key: 'status', label: 'Delivery status' },
          ]}
        />
      )}
    </Card>
  );
}
export function CommunicationsArea({ offline, notice }: { offline: boolean; notice: Notice }) {
  const [data, setData] = useState<Data>(),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [history, setHistory] = useState<DeliverySummary[]>([]),
    [tab, setTab] = useState('Messages'),
    [editor, setEditor] = useState<{ row?: Campaign; type: Campaign['type']; key: string }>(),
    [contact, setContact] = useState<Contact | null | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function refresh() {
    try {
      const [d, h] = await Promise.all([
        api<Data>('/communications'),
        api<DeliverySummary[]>('/communications/history'),
      ]);
      setData(d);
      setHistory(h);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    void api<Snapshot>('/users')
      .then(setSnapshot)
      .catch(() => {});
    const timer = setInterval(() => {
      if (navigator.onLine) void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
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
          <p className="eyebrow">CONTACTS & COMMUNICATIONS</p>
          <h1>Communications</h1>
          <p>Individual emails · UTC schedules · Durable delivery history</p>
        </div>
        <button className="secondary" disabled={offline || busy} onClick={() => void refresh()}>
          Refresh communications
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <Card title="Communications">
          <p role="status">
            {error ? 'Unable to load. Use Refresh to retry.' : 'Loading communication settings…'}
          </p>
        </Card>
      ) : (
        <>
          {data.integration && (
            <p role="status">
              Plex communication source:{' '}
              {data.integration.ok
                ? 'last refresh validated'
                : 'unavailable; queued jobs retry without assuming success'}{' '}
              at {new Date(data.integration.at).toISOString()} (UTC).
            </p>
          )}
          <div className="toolbar" role="navigation" aria-label="Communications sections">
            {['Messages', 'Contacts', 'Automation', 'History'].map((name) => (
              <button
                key={name}
                className="secondary"
                aria-current={tab === name ? 'page' : undefined}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {tab === 'Messages' && (
            <>
              <p>
                Compose a draft, preview its fixed audience, then explicitly confirm. All times
                below are UTC.
              </p>
              {!snapshot && (
                <p className="callout">
                  Select and test Plex in Settings before composing server communications.
                </p>
              )}
              <button
                disabled={offline || busy || !snapshot}
                onClick={() => setEditor({ type: 'announcement', key: crypto.randomUUID() })}
              >
                New announcement
              </button>
              <button
                className="secondary"
                disabled={offline || busy || !snapshot}
                onClick={() => setEditor({ type: 'maintenance', key: crypto.randomUUID() })}
              >
                New maintenance event
              </button>
              {editor && (
                <CampaignEditor
                  key={editor.key}
                  row={editor.row}
                  type={editor.type}
                  settings={data.settings}
                  snapshot={snapshot}
                  offline={offline || busy}
                  onSaved={refresh}
                />
              )}
              <Card title="Drafts, schedules and maintenance events">
                {!data.campaigns.length && (
                  <p className="empty">No communications yet. Create a draft above.</p>
                )}
                {data.campaigns
                  .filter((c) => c.status !== 'deleted')
                  .map((row) => {
                    const p = JSON.parse(row.payload);
                    return (
                      <article className="preview" key={row.id}>
                        <h3>{p.title ?? row.subject}</h3>
                        <Badge>
                          {row.status === 'dispatched'
                            ? 'Audience dispatched to queue'
                            : row.status}
                        </Badge>
                        <p>
                          {row.type === 'maintenance'
                            ? `${p.start} → ${p.end} (UTC)${Date.now() >= Date.parse(p.end) && !['completed', 'cancelled'].includes(row.status) ? ' · Expected end passed; explicit completion still required' : ''}`
                            : `Dispatch: ${row.scheduled ? new Date(row.scheduled).toISOString() : 'not confirmed'} (UTC)`}
                        </p>
                        <button
                          className="secondary"
                          disabled={
                            offline ||
                            busy ||
                            !(
                              row.status === 'draft' ||
                              (row.type === 'maintenance' &&
                                ['scheduled', 'dispatched'].includes(row.status))
                            )
                          }
                          onClick={() =>
                            setEditor({ row, type: row.type, key: `${row.id}:${row.revision}` })
                          }
                        >
                          Edit / preview
                        </button>
                        {row.status === 'draft' ? (
                          <button
                            className="danger"
                            disabled={offline || busy}
                            onClick={() => {
                              if (confirm('Delete this draft? Its audit history is retained.'))
                                void action(async () => {
                                  await api(
                                    `/communications/drafts/${row.id}`,
                                    { confirm: true },
                                    'DELETE',
                                  );
                                  setEditor(undefined);
                                });
                            }}
                          >
                            Delete draft
                          </button>
                        ) : (
                          ['scheduled', 'dispatched'].includes(row.status) && (
                            <>
                              {['scheduled', 'dispatched'].includes(row.status) && (
                                <button
                                  className="danger"
                                  disabled={offline || busy}
                                  onClick={() => {
                                    if (
                                      confirm(
                                        'Cancel remaining unsent jobs? SMTP-accepted mail cannot be recalled.',
                                      )
                                    ) {
                                      const notify =
                                        row.type === 'maintenance' &&
                                        confirm(
                                          'Also queue a cancellation notice to the confirmed audience?',
                                        );
                                      void action(async () => {
                                        await api(`/communications/events/${row.id}/action`, {
                                          action: 'cancel',
                                          notify,
                                          confirm: true,
                                        });
                                        setEditor(undefined);
                                      });
                                    }
                                  }}
                                >
                                  Cancel schedule
                                </button>
                              )}
                              {row.type === 'maintenance' && (
                                <button
                                  disabled={offline || busy}
                                  onClick={() => {
                                    if (
                                      confirm(
                                        'Explicitly mark maintenance complete? Confirm service yourself; this action is not a playback test.',
                                      )
                                    ) {
                                      const notify = confirm(
                                        'Queue a completion notice to the confirmed audience?',
                                      );
                                      void action(async () => {
                                        await api(`/communications/events/${row.id}/action`, {
                                          action: 'complete',
                                          notify,
                                          confirm: true,
                                        });
                                        setEditor(undefined);
                                      });
                                    }
                                  }}
                                >
                                  Complete maintenance
                                </button>
                              )}
                            </>
                          )
                        )}
                      </article>
                    );
                  })}
              </Card>
              <Card title="External worker configuration">
                <p>
                  Local maintenance events use the same monitoring suppression schedule. Provision
                  the outside worker separately before an outage.
                </p>
                {data.external?.ok && !data.external.stale ? (
                  <p role="status">
                    Maintenance configuration:{' '}
                    {data.external.maintenanceMatch === true
                      ? 'authenticated match'
                      : data.external.maintenanceMatch === false
                        ? 'MISMATCH — update worker configuration'
                        : 'unknown; upgrade worker to check'}
                    . Recipient configuration:{' '}
                    {data.external.recipientsMatch === true
                      ? 'authenticated match'
                      : data.external.recipientsMatch === false
                        ? 'MISMATCH — recipients/preferences not provisioned'
                        : 'unknown'}
                    . Last acknowledgement {new Date(data.external.at).toISOString()} (UTC); check
                    freshness before relying on it.
                  </p>
                ) : (
                  <p role="status">
                    Worker configuration unknown or stale: no current authenticated acknowledgement.
                  </p>
                )}
                <p className="muted">
                  Recipient links and local edits do not update the independently operated worker.
                  Apply its own preferences and these windows before relying on whole-NAS alerts. A
                  successful heartbeat alone does not confirm matching configuration.
                </p>
                <details>
                  <summary>Maintenance configuration to provision on the worker</summary>
                  <pre className="plain-text">
                    {JSON.stringify(data.maintenanceExport, null, 2)}
                  </pre>
                </details>
              </Card>
            </>
          )}
          {tab === 'Contacts' && (
            <>
              <Card title="User-linked and standalone contacts">
                <p>
                  Link accepted Plex accounts in the user editor. Standalone recipients remain
                  independent; administrator-provisioned legacy outage recipients are preserved.
                </p>
                <button disabled={offline || busy} onClick={() => setContact(null)}>
                  New standalone contact
                </button>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>Identity</th>
                        <th>Status</th>
                        <th>Preferences</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.contacts.map((c) => (
                        <tr key={c.id}>
                          <td>{c.email}</td>
                          <td>{c.user ? `Plex account ${c.user}` : 'Standalone'}</td>
                          <td>
                            {c.unsubscribed
                              ? 'Unsubscribed'
                              : c.verified
                                ? 'Verified'
                                : c.legacy
                                  ? 'Administrator-provisioned (unverified)'
                                  : 'Verification pending'}
                          </td>
                          <td>
                            {Object.entries(c.preferences)
                              .filter(([, on]) => on)
                              .map(([key]) => key)
                              .join(', ') || 'None'}
                          </td>
                          <td>
                            <button className="text-button" onClick={() => setContact(c)}>
                              Edit contact
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data.contacts.length && <p className="empty">No contacts yet.</p>}
              </Card>
              {contact !== undefined && (
                <Card title="Contact preferences">
                  <ContactEditor
                    key={contact?.id ?? 'new'}
                    contact={contact}
                    userId={contact?.user ?? null}
                    offline={offline || busy}
                    onSaved={refresh}
                  />
                </Card>
              )}
            </>
          )}
          {tab === 'Automation' && (
            <CommunicationSettings
              settings={data.settings}
              offline={offline || busy}
              refresh={refresh}
            />
          )}
          {tab === 'History' && (
            <>
              <Card title="Communication jobs">
                <p>
                  Scheduled jobs are distinct from recipient delivery. Superseded jobs remain
                  visible; a missed interval never creates a burst of old notices.
                </p>
                <JsonHistory
                  items={data.jobs}
                  columns={[
                    { key: 'kind', label: 'Kind' },
                    { key: 'due', label: 'Due (UTC)', date: true },
                    { key: 'status', label: 'Dispatch state' },
                    { key: 'reason', label: 'Reason' },
                  ]}
                />
                {data.jobs
                  .filter((j) => j.status === 'failed')
                  .map((j) => (
                    <button
                      className="secondary"
                      key={j.id}
                      disabled={offline || busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`/communications/jobs/${j.id}/retry`, { confirm: true });
                        })
                      }
                    >
                      Retry failed dispatch {j.kind}
                    </button>
                  ))}
              </Card>
              <Card title="Per-recipient delivery">
                <p>
                  SMTP accepted does not mean inbox delivery. Acceptance after a disconnected SMTP
                  session may be unknown; retries can duplicate a message.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Recipient</th>
                        <th>Kind</th>
                        <th>State</th>
                        <th>Attempts</th>
                        <th>Failure / retry</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((row) => (
                        <tr key={row.id}>
                          <td>{row.recipient}</td>
                          <td>{row.kind}</td>
                          <td>
                            {row.status === 'sent'
                              ? 'SMTP accepted'
                              : row.status === 'pending'
                                ? 'Queued'
                                : row.status}
                          </td>
                          <td>{row.attempts}</td>
                          <td>
                            {row.error}
                            {row.status === 'failed' && (
                              <button
                                className="text-button"
                                disabled={offline || busy}
                                onClick={() =>
                                  void action(async () => {
                                    await api(`/deliveries/${row.id}/retry`, {});
                                  })
                                }
                              >
                                Retry delivery
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!history.length && <p className="empty">No deliveries yet.</p>}
              </Card>
              <Card title="Membership welcome tracking">
                <JsonHistory
                  items={data.memberships}
                  columns={[
                    { key: 'user', label: 'Plex account' },
                    { key: 'status', label: 'Last confirmed membership' },
                    { key: 'welcome', label: 'Welcome state' },
                  ]}
                />
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
