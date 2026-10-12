import { useState } from 'react';
import { api } from './api';
import { Card, Field } from './components';
import type { CommunicationsSettings } from '../server/communications-config';
export function CommunicationSettings({
  settings,
  offline,
  refresh,
}: {
  settings: CommunicationsSettings;
  offline: boolean;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings),
    [leadTimes, setLeadTimes] = useState(settings.expiry.leads.join(', ')),
    [administrators, setAdministrators] = useState(settings.expiry.administrators.join(', ')),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const patchWelcome = (key: string, value: unknown) =>
    setDraft({ ...draft, welcome: { ...draft.welcome, [key]: value } });
  const patchExpiry = (key: string, value: unknown) =>
    setDraft({ ...draft, expiry: { ...draft.expiry, [key]: value } });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (offline) return;
        setBusy(true);
        setMessage('');
        try {
          await api(
            '/communications/settings',
            {
              ...draft,
              expiry: {
                ...draft.expiry,
                leads: leadTimes.trim() ? leadTimes.split(',').map((v) => Number(v.trim())) : [],
                administrators: administrators
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              },
            },
            'PUT',
          );
          await refresh();
          setMessage('Automation settings saved. Obsolete queued templates are superseded.');
        } catch (e) {
          setMessage((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={offline || busy}>
        <legend>Communications automation settings</legend>
        <Card title="Welcome messages">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.welcome.enabled}
              onChange={(e) => patchWelcome('enabled', e.target.checked)}
            />
            Enable automatic welcome for reliably observed invitation acceptance
          </label>
          <p>
            Existing users are a baseline and are never welcomed merely by enabling this. Changed
            invitation IDs and managed users require an explicit manual welcome.
          </p>
          {(
            ['subject', 'body', 'gettingStarted', 'rules', 'requestUrl', 'supportUrl'] as const
          ).map((key) => (
            <Field key={key} label={`Welcome ${key}`}>
              {['body', 'gettingStarted', 'rules'].includes(key) ? (
                <textarea
                  value={draft.welcome[key]}
                  onChange={(e) => patchWelcome(key, e.target.value)}
                  maxLength={10000}
                />
              ) : (
                <input
                  value={draft.welcome[key]}
                  onChange={(e) => patchWelcome(key, e.target.value)}
                  maxLength={key === 'subject' ? 200 : 1000}
                />
              )}
            </Field>
          ))}
          <p className="muted">
            Variables:{' '}
            {
              '{{server}}, {{libraries}}, {{gettingStarted}}, {{rules}}, {{requestUrl}}, {{supportUrl}}'
            }
            . Use public HTTPS recipient links; never administrative links, tokens or private
            network addresses. Preview and test with a selected user in the user editor.
          </p>
        </Card>
        <Card title="Access-expiry reminders">
          <label className="check">
            <input
              type="checkbox"
              checked={draft.expiry.enabled}
              onChange={(e) => patchExpiry('enabled', e.target.checked)}
            />
            Enable expiry reminders
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.expiry.user}
              onChange={(e) => patchExpiry('user', e.target.checked)}
            />
            Send to eligible verified user contacts
          </label>
          <Field label="Reminder lead times (seconds, comma-separated)">
            <input value={leadTimes} onChange={(e) => setLeadTimes(e.target.value)} />
          </Field>
          <p className="muted">
            604800 = seven days; 86400 = one day. After downtime, only the latest due reminder is
            eligible.
          </p>
          <Field label="Administrator reminder/failure recipients">
            <input
              value={administrators}
              onChange={(e) => setAdministrators(e.target.value)}
              placeholder="admin@example.com"
            />
          </Field>
          <p>
            Use administrator-controlled addresses. Failed revocation generates an administrator
            notice; users are never told access was removed without confirmation.
          </p>
          {(['subject', 'body', 'instructions', 'renewalUrl'] as const).map((key) => (
            <Field key={key} label={`Expiry ${key}`}>
              {['body', 'instructions'].includes(key) ? (
                <textarea
                  value={draft.expiry[key]}
                  onChange={(e) => patchExpiry(key, e.target.value)}
                  maxLength={10000}
                />
              ) : (
                <input
                  value={draft.expiry[key]}
                  onChange={(e) => patchExpiry(key, e.target.value)}
                  maxLength={key === 'subject' ? 200 : 1000}
                />
              )}
            </Field>
          ))}
          <p className="muted">
            Variables: {'{{server}}, {{expires}}, {{instructions}}, {{renewalUrl}}'}. Times are UTC.
            A link does not renew access. No payments or billing are introduced.
          </p>
        </Card>
        <Card title="Maintenance notice defaults">
          {(['subject', 'body'] as const).map((key) => (
            <Field key={key} label={`Maintenance default ${key}`}>
              {key === 'body' ? (
                <textarea
                  value={draft.maintenance[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      maintenance: { ...draft.maintenance, [key]: e.target.value },
                    })
                  }
                />
              ) : (
                <input
                  value={draft.maintenance[key]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      maintenance: { ...draft.maintenance, [key]: e.target.value },
                    })
                  }
                />
              )}
            </Field>
          ))}
          <p>
            Variables: {'{{title}}, {{explanation}}, {{server}}, {{start}}, {{end}}, {{change}}'}.
            Each event saves its own templates.
          </p>
        </Card>
        <Field label="Maximum messages per delivery batch">
          <input
            type="number"
            min={1}
            max={20}
            value={draft.batchSize}
            onChange={(e) => setDraft({ ...draft, batchSize: Number(e.target.value) })}
          />
        </Field>
        <p className="muted">
          One SMTP send at a time, up to this many every five-second queue pass. Queued means
          awaiting delivery; SMTP accepted is not confirmed inbox delivery.
        </p>
        <button>{busy ? 'Saving…' : 'Save communications automation'}</button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
