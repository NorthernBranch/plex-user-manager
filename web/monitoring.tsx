import { useState } from 'react';
import { api } from './api';
import { Badge, Card, Field, JsonHistory } from './components';
import type { Health, Notice, Settings } from './types';
export function Monitoring({
  settings,
  health,
  refresh,
  notice,
  offline,
}: {
  settings: Settings;
  health: Health;
  refresh: () => Promise<void>;
  notice: Notice;
  offline: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.monitor }),
    [busy, setBusy] = useState(false),
    [maintenanceStart, setMaintenanceStart] = useState(''),
    [maintenanceEnd, setMaintenanceEnd] = useState('');
  const set = (name: string, value: unknown) => setDraft({ ...draft, [name]: value });
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">BACKEND MONITORING</p>
          <h1>Monitoring & incidents</h1>
          <p>Checks run on the server even when this PWA is closed.</p>
        </div>
        <Badge tone={health.state.unknown ? 'warning' : health.state.lastOk ? 'good' : 'bad'}>
          {health.state.unknown ? 'Unknown' : health.state.state}
        </Badge>
      </div>
      <div className="callout">
        <strong>Know what is being checked</strong>
        <p>
          The local probe validates the selected Plex server’s identity API. It does not prove
          external access or successful playback. A monitor on the NAS cannot send while the NAS,
          power or internet is unavailable.
        </p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/monitor', draft, 'PUT');
            await refresh();
            notice('Monitoring preferences saved. Failure continuity restarts at this change.');
          } catch (error) {
            notice((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid two">
          <Card title="4. Detection preferences">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              Enable monitoring
            </label>
            {(
              [
                ['intervalSeconds', 'Check interval (seconds)', 5, 3600],
                ['timeoutSeconds', 'Request timeout (seconds)', 1, 60],
                ['failureSeconds', 'Continuous failure before outage (seconds)', 5, 86400],
                ['recoveryCount', 'Consecutive successful checks for recovery', 1, 20],
              ] as const
            ).map(([key, label, min, max]) => (
              <Field key={key} label={String(label)}>
                <input
                  type="number"
                  required
                  value={draft[key]}
                  min={Number(min)}
                  max={Number(max)}
                  onChange={(e) => set(String(key), Number(e.target.value))}
                />
              </Field>
            ))}
            <Field label="Notification authority">
              <select value={draft.authority} onChange={(e) => set('authority', e.target.value)}>
                <option value="local">Local monitoring</option>
                <option value="external">External worker (must be provisioned)</option>
              </select>
            </Field>
            <p className="muted">
              Choose one authority. External worker settings and recipients are independently
              provisioned; saving here does not synchronise them.
            </p>
          </Card>
          <Card title="Recipients">
            <p>Each address receives a separate email. No automatic Plex address discovery.</p>
            <p className="muted">
              Recovery-only preferences receive a recovery without an outage email. With both
              enabled, recovery requires an accepted outage for that recipient.
            </p>
            {draft.recipients.map((r, i: number) => (
              <fieldset key={i}>
                <legend>Recipient {i + 1}</legend>
                <Field label="Email address">
                  <input
                    type="email"
                    required
                    value={r.email}
                    onChange={(e) =>
                      set(
                        'recipients',
                        draft.recipients.map((item, index: number) =>
                          index === i ? { ...item, email: e.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
                {(['outage', 'recovery'] as const).map((kind) => (
                  <label key={kind} className="check">
                    <input
                      type="checkbox"
                      checked={r[kind]}
                      onChange={(e) =>
                        set(
                          'recipients',
                          draft.recipients.map((item, index: number) =>
                            index === i ? { ...item, [kind]: e.target.checked } : item,
                          ),
                        )
                      }
                    />
                    {kind === 'outage' ? 'Outage emails' : 'Recovery emails'}
                  </label>
                ))}
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() =>
                    set(
                      'recipients',
                      draft.recipients.filter((_r, index: number) => index !== i),
                    )
                  }
                >
                  Remove recipient
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                set('recipients', [
                  ...draft.recipients,
                  { email: '', outage: true, recovery: true },
                ])
              }
            >
              Add recipient
            </button>
          </Card>
          <Card title="Maintenance windows">
            <p>
              UTC windows suppress outage notifications. If an outage remains active when a window
              ends, monitoring resumes alerts. Manage titled events and advance notices in
              Communications. The end of a window does not prove recovery.
            </p>
            <Field label="Start (UTC)">
              <input
                type="datetime-local"
                value={maintenanceStart}
                onChange={(e) => setMaintenanceStart(e.target.value)}
              />
            </Field>
            <Field label="End (UTC)">
              <input
                type="datetime-local"
                value={maintenanceEnd}
                onChange={(e) => setMaintenanceEnd(e.target.value)}
              />
            </Field>
            <button
              type="button"
              className="secondary"
              disabled={!maintenanceStart || !maintenanceEnd}
              onClick={() => {
                if (maintenanceEnd <= maintenanceStart) {
                  notice('Maintenance end must follow start.');
                  return;
                }
                set('maintenance', [
                  ...draft.maintenance,
                  {
                    start: new Date(`${maintenanceStart}:00Z`).toISOString(),
                    end: new Date(`${maintenanceEnd}:00Z`).toISOString(),
                  },
                ]);
                setMaintenanceStart('');
                setMaintenanceEnd('');
              }}
            >
              Add window
            </button>
            {draft.maintenance.map((w, i: number) => (
              <p key={i}>
                {new Date(w.start).toISOString()} → {new Date(w.end).toISOString()}{' '}
                {w.eventId ? (
                  <span className="muted">Managed in Communications</span>
                ) : (
                  <button
                    type="button"
                    className="text-button danger"
                    onClick={() =>
                      set(
                        'maintenance',
                        draft.maintenance.filter((_w, index: number) => index !== i),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </p>
            ))}
          </Card>
          <Card title="Email templates">
            <p>
              Variables: {'{{incident}}, {{started}}, {{recovered}}, {{downtime}}, {{scope}}'}.
              Plain text only.
            </p>
            {(
              [
                ['outageSubject', 'Outage subject'],
                ['outageBody', 'Outage body'],
                ['recoverySubject', 'Recovery subject'],
                ['recoveryBody', 'Recovery body'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                {key.endsWith('Body') ? (
                  <textarea
                    required
                    value={draft[key]}
                    maxLength={10000}
                    onChange={(e) => set(key, e.target.value)}
                  />
                ) : (
                  <input
                    required
                    value={draft[key]}
                    maxLength={200}
                    onChange={(e) => set(key, e.target.value)}
                  />
                )}
              </Field>
            ))}
          </Card>
        </div>
        <button disabled={offline || busy}>
          {busy ? 'Saving…' : 'Save monitoring & notification preferences'}
        </button>
      </form>
      <Card title="Incidents">
        <JsonHistory
          items={health.incidents}
          columns={[
            { key: 'started', label: 'Started', date: true },
            { key: 'confirmed', label: 'Confirmed', date: true },
            { key: 'recovered', label: 'Recovered', date: true },
            { key: 'observed', label: 'Observed downtime (ms)' },
            { key: 'scope', label: 'Scope' },
          ]}
        />
      </Card>
      <Card title="Timeline">
        <JsonHistory
          items={health.timeline}
          columns={[
            { key: 'at', label: 'Time', date: true },
            { key: 'event', label: 'Event' },
          ]}
        />
      </Card>
      <Card title="Access expiry jobs">
        <JsonHistory
          items={health.expiries}
          columns={[
            { key: 'user', label: 'Account ID' },
            { key: 'server', label: 'Server ID' },
            { key: 'due', label: 'Due', date: true },
            { key: 'status', label: 'Status' },
            { key: 'error', label: 'Failure details' },
          ]}
        />
        <p className="muted">
          Jobs for another selected server remain paused. For a failed job, refresh the user’s
          current access and set a new expiry to retry.
        </p>
      </Card>
    </>
  );
}
