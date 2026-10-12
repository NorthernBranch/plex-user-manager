import { useState } from 'react';
import { api } from './api';
import { Card, Field } from './components';
import type { Campaign } from '../server/communications';
import type { CommunicationsSettings } from '../server/communications-config';
import type { AudienceRule } from '../server/communication-audience';
import type { Snapshot } from './types';
type Preview = {
  ticket: string;
  subject: string;
  body: string;
  includedCount: number;
  excludedCount: number;
  duplicateCount: number;
  included: { email: string }[];
  excluded: { email: string; reason: string }[];
};
type Draft = {
  type: 'announcement' | 'maintenance';
  subject: string;
  body: string;
  rule: AudienceRule;
  title: string;
  explanation: string;
  start: string;
  end: string;
  leads: number[];
  notifyChange: boolean;
};
const utc = (value: string) => (value ? new Date(`${value}:00Z`).toISOString() : undefined);
function initial(
  row: Campaign | undefined,
  settings: CommunicationsSettings,
  type: Draft['type'],
): Draft {
  const payload = row ? JSON.parse(row.payload) : {};
  return {
    type: row?.type ?? type,
    subject: row?.subject ?? (type === 'maintenance' ? settings.maintenance.subject : ''),
    body: row?.body ?? (type === 'maintenance' ? settings.maintenance.body : ''),
    rule: payload.rule ?? { mode: 'all', ids: [] },
    title: payload.title ?? '',
    explanation: payload.explanation ?? '',
    start: payload.start?.slice(0, 16) ?? '',
    end: payload.end?.slice(0, 16) ?? '',
    leads: payload.leads ?? [86400, 3600],
    notifyChange: false,
  };
}
export function CampaignEditor({
  row,
  type,
  settings,
  snapshot,
  offline,
  onSaved,
}: {
  row?: Campaign;
  type: Draft['type'];
  settings: CommunicationsSettings;
  snapshot?: Snapshot;
  offline: boolean;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => initial(row, settings, type)),
    [saved, setSaved] = useState(row),
    [preview, setPreview] = useState<Preview>(),
    [schedule, setSchedule] = useState(''),
    [testRecipient, setTestRecipient] = useState(''),
    [leadTimes, setLeadTimes] = useState(() => initial(row, settings, type).leads.join(', ')),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const set = (key: keyof Draft, value: unknown) => {
    setDraft({ ...draft, [key]: value });
    setPreview(undefined);
  };
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active = saved && saved.status !== 'draft';
  return (
    <Card title={draft.type === 'maintenance' ? 'Maintenance event' : 'Announcement draft'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (offline) return;
          void action(async () => {
            const value = await api<Campaign>(
              saved ? `/communications/drafts/${saved.id}` : '/communications/drafts',
              {
                ...draft,
                start: utc(draft.start),
                end: utc(draft.end),
                leads: leadTimes.trim() ? leadTimes.split(',').map((v) => Number(v.trim())) : [],
              },
              saved ? 'PUT' : 'POST',
            );
            setSaved(value);
            setPreview(undefined);
            setMessage(
              active
                ? 'Maintenance updated; earlier notices superseded.'
                : 'Draft saved. Preview recipients before confirming.',
            );
          });
        }}
      >
        <fieldset disabled={offline || busy || (!!active && draft.type === 'announcement')}>
          <legend>
            {draft.type === 'maintenance' ? 'Maintenance details (UTC)' : 'Message content'}
          </legend>
          {draft.type === 'maintenance' && (
            <>
              <Field label="Maintenance title">
                <input
                  required
                  value={draft.title}
                  onChange={(e) => set('title', e.target.value)}
                  maxLength={160}
                />
              </Field>
              <Field label="Maintenance explanation">
                <textarea
                  required
                  value={draft.explanation}
                  onChange={(e) => set('explanation', e.target.value)}
                  maxLength={5000}
                />
              </Field>
              <Field label="Maintenance start (UTC)">
                <input
                  type="datetime-local"
                  required
                  value={draft.start}
                  onChange={(e) => set('start', e.target.value)}
                />
              </Field>
              <Field label="Expected maintenance end (UTC)">
                <input
                  type="datetime-local"
                  required
                  value={draft.end}
                  onChange={(e) => set('end', e.target.value)}
                />
              </Field>
              <Field label="Advance notice lead times (seconds)">
                <input
                  value={leadTimes}
                  onChange={(e) => {
                    setLeadTimes(e.target.value);
                    setPreview(undefined);
                  }}
                />
              </Field>
              <p>
                86400 = 24 hours; 3600 = one hour. Leave empty for no advance notices. Passing the
                expected end resumes ordinary monitoring but never sends a completion message
                automatically.
              </p>
              {active && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.notifyChange}
                    onChange={(e) => set('notifyChange', e.target.checked)}
                  />
                  Notify the confirmed audience of this edit or extension
                </label>
              )}
            </>
          )}
          <Field label="Message subject">
            <input
              required
              maxLength={200}
              value={draft.subject}
              onChange={(e) => set('subject', e.target.value)}
            />
          </Field>
          <Field label="Plain-text message body">
            <textarea
              required
              maxLength={10000}
              value={draft.body}
              onChange={(e) => set('body', e.target.value)}
            />
          </Field>
          <Field label="Recipient targeting">
            <select
              disabled={!!active}
              value={draft.rule.mode}
              onChange={(e) => set('rule', { mode: e.target.value, ids: [] })}
            >
              <option value="all">All eligible contacts</option>
              <option value="users">Selected Plex users</option>
              <option value="libraries">Users with selected library access</option>
            </select>
          </Field>
          {draft.rule.mode !== 'all' && (
            <Field
              label={
                draft.rule.mode === 'users' ? 'Select target users' : 'Select target libraries'
              }
            >
              <select
                multiple
                disabled={!!active}
                value={draft.rule.ids}
                onChange={(e) =>
                  set('rule', {
                    ...draft.rule,
                    ids: [...e.target.selectedOptions].map((o) => o.value),
                  })
                }
              >
                {(draft.rule.mode === 'users'
                  ? snapshot?.users
                      .filter((u) => u.kind !== 'pending')
                      .map((u) => ({ id: u.id, name: u.name }))
                  : snapshot?.libraries.map((l) => ({ id: l.id, name: l.title }))
                )?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button disabled={!snapshot}>
            {busy ? 'Saving…' : active ? 'Save maintenance edit / extension' : 'Save draft'}
          </button>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
      {saved && (
        <>
          <Field label="Test recipient (address you control)">
            <input
              type="email"
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value)}
              disabled={offline || busy}
            />
          </Field>
          <button
            className="secondary"
            disabled={offline || busy || !testRecipient}
            onClick={() => {
              if (confirm('Queue a requested test to this address?'))
                void action(async () => {
                  await api(`/communications/drafts/${saved.id}/test`, {
                    recipient: testRecipient,
                    confirm: true,
                  });
                  setMessage('Test queued. Inspect SMTP acceptance in history.');
                });
            }}
          >
            Queue message test
          </button>
          {saved.status === 'draft' && (
            <button
              className="secondary"
              disabled={offline || busy}
              onClick={() =>
                void action(async () =>
                  setPreview(await api(`/communications/drafts/${saved.id}/preview`, {})),
                )
              }
            >
              Preview recipients and content
            </button>
          )}
        </>
      )}
      {preview && saved && (
        <section className="preview" aria-label="Final communication confirmation">
          <h3>Review before sending</h3>
          <p>
            {preview.includedCount} included addresses · {preview.excludedCount} excluded contacts ·{' '}
            {preview.duplicateCount} duplicate addresses collapsed
          </p>
          <h4>{preview.subject}</h4>
          <p className="plain-text">{preview.body}</p>
          <details>
            <summary>Included recipients</summary>
            {[...new Set(preview.included.map((r) => r.email))].map((email) => (
              <p key={email}>{email}</p>
            ))}
          </details>
          <details>
            <summary>Excluded contacts and reasons</summary>
            {preview.excluded.map((r, i) => (
              <p key={i}>
                {r.email}: {r.reason}
              </p>
            ))}
          </details>
          {draft.type === 'announcement' && (
            <Field label="Scheduled dispatch (UTC; blank sends immediately)">
              <input
                type="datetime-local"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                disabled={offline || busy}
              />
            </Field>
          )}
          <p>
            {draft.type === 'maintenance'
              ? `Advance notices use the event’s UTC start and lead times. Server: ${snapshot?.server ?? 'selected server'}.`
              : `Dispatch: ${schedule ? `${utc(schedule)} (UTC)` : 'immediately'}.`}{' '}
            The confirmed contact IDs are fixed; new users will not be added automatically.
          </p>
          <button
            disabled={offline || busy || (!preview.includedCount && draft.type === 'announcement')}
            onClick={() => {
              if (
                confirm(
                  `Confirm ${preview.includedCount} recipients for ${draft.type === 'maintenance' ? 'this maintenance schedule' : schedule ? `${utc(schedule)} UTC` : 'immediate sending'}?`,
                )
              )
                void action(async () => {
                  setSaved(
                    await api(`/communications/drafts/${saved.id}/confirm`, {
                      ticket: preview.ticket,
                      scheduled: draft.type === 'announcement' && schedule ? utc(schedule) : null,
                      confirm: true,
                    }),
                  );
                  setPreview(undefined);
                  setMessage(
                    'Confirmed audience saved. Messages are scheduled/queued, not yet accepted by SMTP.',
                  );
                });
            }}
          >
            Confirm {draft.type === 'maintenance' ? 'maintenance notices' : 'announcement dispatch'}
          </button>
        </section>
      )}
    </Card>
  );
}
