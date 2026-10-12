import { useState } from 'react';
import { api, setCsrf } from './api';
import { Field } from './components';
export function Login({ initialized, onLogin }: { initialized: boolean; onLogin: () => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="brand">
        <img src="/icon.svg" alt="" />
        <span>Plex User Manager</span>
      </div>
      <section className="card">
        <p className="eyebrow">YOUR SERVER. YOUR CONTROL.</p>
        <h1>{initialized ? 'Welcome back' : 'Establish your administrator'}</h1>
        <p>
          {initialized
            ? 'Sign in with your application administrator credentials.'
            : 'Use the one-time bootstrap secret from your deployment to secure this installation.'}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            const form = new FormData(e.currentTarget);
            try {
              const result = await api(initialized ? '/login' : '/setup', Object.fromEntries(form));
              setCsrf(result.csrf);
              onLogin();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {!initialized && (
            <Field label="Bootstrap secret">
              <input name="bootstrap" type="password" autoComplete="off" required />
            </Field>
          )}
          <Field label="Administrator username">
            <input name="username" autoComplete="username" minLength={3} maxLength={80} required />
          </Field>
          <Field label="Password" hint="At least 12 characters. This login is separate from Plex.">
            <input
              name="password"
              type="password"
              autoComplete={initialized ? 'current-password' : 'new-password'}
              minLength={12}
              maxLength={256}
              required
            />
          </Field>
          <button disabled={busy || !navigator.onLine}>
            {busy ? 'Working…' : initialized ? 'Sign in' : 'Secure this installation'}
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </section>
      <p className="muted">No telemetry. Credentials stay on this installation.</p>
    </main>
  );
}
