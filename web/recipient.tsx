import { useState, useEffect } from 'react';
import { PreferenceFields } from './contact-editor';
import { noPreferences, type Preferences } from '../server/communication-preferences';
type View = {
  email: string;
  verified: boolean;
  unsubscribed: boolean;
  preferences: Preferences;
  scope: string;
  expires: number;
};
export function RecipientPage({ token }: { token: string }) {
  const [view, setView] = useState<View>(),
    [preferences, setPreferences] = useState(noPreferences),
    [unsubscribed, setUnsubscribed] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(!navigator.onLine),
    [complete, setComplete] = useState(false);
  async function request(action: string, extra: Record<string, unknown> = {}) {
    if (!navigator.onLine) throw new Error('Offline. No actions are queued or replayed.');
    const response = await fetch(`/api/recipient/${action}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...extra }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Link invalid or expired.');
    return data;
  }
  useEffect(() => {
    const handler = () => setOffline(!navigator.onLine);
    window.addEventListener('online', handler);
    window.addEventListener('offline', handler);
    request('view')
      .then((data: View) => {
        setView(data);
        setPreferences(data.preferences);
        setUnsubscribed(data.unsubscribed);
      })
      .catch((e) => setMessage(e.message));
    return () => {
      window.removeEventListener('online', handler);
      window.removeEventListener('offline', handler);
    };
  }, []);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <img src="/icon.svg" alt="" />
        Plex User Manager
      </div>
      <h1>Notification preferences</h1>
      <p>
        This page controls email communications only. It grants no Plex access or administrator
        rights.
      </p>
      {message && <p role="status">{message}</p>}
      {offline && <p role="alert">Offline — actions disabled.</p>}
      {!view && !message && <p role="status">Checking the scoped link…</p>}
      {view && (
        <>
          <p>Address: {view.email}</p>
          <p>
            Verification: {view.verified ? 'verified' : 'not yet verified'}. Link expires{' '}
            {new Date(view.expires).toISOString()} (UTC).
          </p>
          {view.scope === 'verify' ? (
            <>
              <p>Verification does not subscribe you to any category.</p>
              <button
                disabled={busy || offline || complete}
                onClick={() => {
                  if (confirm('Verify this notification email address?'))
                    void action(async () => {
                      await request('verify', { confirm: true });
                      setComplete(true);
                      setMessage(
                        'Address verified. Consent is unchanged. Use the separate preferences link to manage categories.',
                      );
                    });
                }}
              >
                Confirm address verification
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (confirm('Save these email preferences for this entire address?'))
                  void action(async () => {
                    const data = await request('preferences', {
                      preferences,
                      unsubscribed,
                      confirm: true,
                    });
                    setView(data);
                    setMessage(
                      'Preferences saved. Already queued messages will recheck these preferences before sending.',
                    );
                  });
              }}
            >
              <PreferenceFields
                value={preferences}
                onChange={setPreferences}
                disabled={busy || offline}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={unsubscribed}
                  onChange={(e) => setUnsubscribed(e.target.checked)}
                  disabled={busy || offline}
                />
                Unsubscribe this address from all communications
              </label>
              <p>
                If multiple contacts share this address, these choices apply to all of them. Address
                verification is a separate action.
              </p>
              <button disabled={busy || offline}>Confirm preference changes</button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
