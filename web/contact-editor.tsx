import { useState } from 'react';
import { api } from './api';
import { Field, Badge } from './components';
import { categories, noPreferences, type Preferences } from '../server/communication-preferences';
import type { Contact } from '../server/recipients';
export const preferenceLabels = {
  outage: 'Outage alerts',
  recovery: 'Recovery alerts',
  maintenance: 'Maintenance notices',
  announcement: 'General announcements',
  welcome: 'Welcome messages',
  expiry: 'Access-expiry reminders',
};
export function PreferenceFields({
  value,
  onChange,
  disabled = false,
}: {
  value: Preferences;
  onChange: (v: Preferences) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Communications preferences</legend>
      {categories.map((category) => (
        <label className="check" key={category}>
          <input
            type="checkbox"
            checked={value[category]}
            onChange={(e) => onChange({ ...value, [category]: e.target.checked })}
          />
          {preferenceLabels[category]}
        </label>
      ))}
    </fieldset>
  );
}
export function ContactEditor({
  contact: initial,
  userId,
  pending = false,
  offline,
  onSaved,
}: {
  contact?: Contact | null;
  userId: string | null;
  pending?: boolean;
  offline: boolean;
  onSaved: () => Promise<void>;
}) {
  const [contact, setContact] = useState(initial),
    [email, setEmail] = useState(initial?.email ?? ''),
    [preferences, setPreferences] = useState(initial?.preferences ?? noPreferences),
    [active, setActive] = useState(initial?.active ?? true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
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
  return (
    <section aria-label="Notification contact">
      <h3>Notification contact</h3>
      <p>
        Plex identity and notification email are separate. An invitation address is never assumed
        verified.
      </p>
      {pending && (
        <p className="callout">
          Wait for acceptance, then link the confirmed account. No display-name or invitation-email
          matching is performed.
        </p>
      )}
      {contact && (
        <p>
          <Badge>
            {contact.unsubscribed
              ? 'Address unsubscribed'
              : contact.verified
                ? 'Address verified'
                : contact.legacy
                  ? 'Administrator-provisioned; unverified'
                  : 'Verification pending'}
          </Badge>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pending || offline) return;
          if (
            contact &&
            email.toLowerCase() !== contact.email &&
            !confirm(
              'Change the notification address? Verification resets and old links stop working.',
            )
          )
            return;
          void action(async () => {
            const saved = await api<Contact>(
              contact ? `/contacts/${contact.id}` : '/contacts',
              {
                email,
                preferences,
                active,
                user: userId,
                confirmEmailChange: !!contact && email.toLowerCase() !== contact.email,
              },
              contact ? 'PUT' : 'POST',
            );
            setContact(saved);
            setMessage(
              'Contact saved. Address verification and notification consent are separate.',
            );
          });
        }}
      >
        <fieldset disabled={pending || offline || busy}>
          <legend>Contact address</legend>
          <Field label="Notification email address">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Enable this contact
          </label>
          <PreferenceFields value={preferences} onChange={setPreferences} />
          <button>Save notification contact</button>
        </fieldset>
      </form>
      <button
        type="button"
        className="secondary"
        disabled={offline || busy || !contact?.active || contact.unsubscribed}
        onClick={() => {
          if (confirm('Queue verification/preferences links to this address?'))
            void action(async () => {
              await api(`/contacts/${contact!.id}/links`, { confirm: true });
              setMessage('Links queued. Check SMTP acceptance in Communications history.');
            });
        }}
      >
        Queue recipient links
      </button>
      <button
        type="button"
        className="secondary"
        disabled={offline || busy || !contact}
        onClick={() =>
          void action(async () => {
            const fresh = (await api<Contact[]>('/contacts')).find((c) => c.id === contact!.id);
            setContact(fresh);
            if (fresh) {
              setPreferences(fresh.preferences);
              setEmail(fresh.email);
              setActive(fresh.active);
            }
            setMessage('Contact status refreshed.');
          })
        }
      >
        Refresh contact status
      </button>
      <p className="muted">
        Shared addresses receive one generic message. Welcome messages and user-specific expiry
        reminders are blocked when different Plex users share an address. Recipient opt-outs apply
        to the entire email address.
      </p>
    </section>
  );
}
