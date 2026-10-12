import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, setCsrf } from './api';
import { Login } from './auth';
import { Badge, Card, JsonHistory } from './components';
import { Users } from './users';
import { SettingsPage } from './settings';
import { Notifications } from './notifications';
import { Monitoring } from './monitoring';
import type { Health, Settings, AuditEntry } from './types';
import './style.css';
const tabs = ['Dashboard', 'Users', 'Monitoring', 'Notifications', 'Settings', 'Audit'];
function App() {
  const [initialized, setInitialized] = useState<boolean>(),
    [loggedIn, setLoggedIn] = useState(false),
    [page, setPage] = useState('Dashboard'),
    [settings, setSettings] = useState<Settings>(),
    [health, setHealth] = useState<Health>(),
    [message, setMessage] = useState(''),
    [offline, setOffline] = useState(!navigator.onLine),
    [audit, setAudit] = useState<AuditEntry[]>([]);
  const notice = (value: string) => setMessage(value);
  async function refresh() {
    const [s, h] = await Promise.all([api<Settings>('/settings'), api<Health>('/monitor')]);
    setSettings(s);
    setHealth(h);
  }
  async function load() {
    try {
      const session = await api('/session');
      setCsrf(session.csrf);
      setLoggedIn(true);
      await refresh();
    } catch {
      setLoggedIn(false);
    }
  }
  useEffect(() => {
    api('/setup/status')
      .then((data) => {
        setInitialized(data.initialized);
        if (data.initialized) void load();
      })
      .catch(() => notice('Could not reach this installation. Check connectivity.'));
    const handler = () => setOffline(!navigator.onLine);
    window.addEventListener('online', handler);
    window.addEventListener('offline', handler);
    return () => {
      window.removeEventListener('online', handler);
      window.removeEventListener('offline', handler);
    };
  }, []);
  useEffect(() => {
    if (!loggedIn) return;
    const timer = setInterval(() => {
      if (navigator.onLine)
        void refresh().catch(() => notice('Session or connection expired. Reload to sign in.'));
    }, 15000);
    return () => clearInterval(timer);
  }, [loggedIn]);
  useEffect(() => {
    if (page === 'Audit')
      void api('/audit')
        .then(setAudit)
        .catch((e) => notice(e.message));
  }, [page]);
  if (initialized === undefined)
    return (
      <main className="login">
        <h1>Plex User Manager</h1>
        <p role="status">{message || 'Connecting to your installation…'}</p>
      </main>
    );
  if (!loggedIn)
    return (
      <Login
        initialized={initialized}
        onLogin={() => {
          setInitialized(true);
          void load();
        }}
      />
    );
  if (!settings || !health)
    return (
      <main className="login">
        <p role="status">Loading installation settings…</p>
      </main>
    );
  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <aside>
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <span>
            Plex
            <br /> User Manager
          </span>
        </div>
        <p className="eyebrow nav-label">ADMINISTRATION</p>
        <nav aria-label="Main navigation">
          {tabs.map((tab, i) => (
            <button
              key={tab}
              aria-current={page === tab ? 'page' : undefined}
              className={page === tab ? 'active' : ''}
              onClick={() => {
                setPage(tab);
                setMessage('');
              }}
            >
              <span aria-hidden="true">{['◫', '♙', '◉', '✉', '⚙', '≡'][i]}</span>
              {tab}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Badge tone={offline ? 'warning' : 'good'}>{offline ? 'Offline' : 'Connected'}</Badge>
          <p>Self-hosted · No telemetry</p>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api('/logout', {});
                setCsrf('');
                setLoggedIn(false);
              } catch (e) {
                notice((e as Error).message);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <span>{settings.server?.name ?? 'Complete first-run setup'}</span>
          <span className="muted">Administrator</span>
        </header>
        <main id="content">
          <div role="status" aria-live="polite">
            {message && (
              <div className="notice">
                {message}
                <button
                  className="text-button"
                  onClick={() => setMessage('')}
                  aria-label="Dismiss message"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
          {offline && (
            <div className="callout" role="alert">
              <strong>You are offline</strong>
              <p>
                Current information may be stale. Mutations are disabled and never replayed later.
                Background monitoring runs on the server.
              </p>
            </div>
          )}
          {page === 'Dashboard' && (
            <>
              <div className="page-title">
                <div>
                  <p className="eyebrow">SERVER OVERVIEW</p>
                  <h1>Your Plex, under control.</h1>
                  <p>Manage access. Keep people informed.</p>
                </div>
                <Badge
                  tone={health.state.unknown ? 'warning' : health.state.lastOk ? 'good' : 'bad'}
                >
                  {health.state.unknown ? 'Awaiting probe' : health.state.state}
                </Badge>
              </div>
              {!settings.server && (
                <div className="callout">
                  <strong>Finish setup</strong>
                  <p>
                    Connect Plex, select and test an owned server, then configure optional SMTP and
                    monitoring preferences.
                  </p>
                  <button onClick={() => setPage('Settings')}>Open integration settings</button>
                </div>
              )}
              <div className="grid metrics">
                <Card title="Plex integration">
                  <div className="metric">{settings.server ? 'Connected' : 'Setup needed'}</div>
                  <p>{settings.server?.name ?? 'Select an owned server'}</p>
                </Card>
                <Card title="Availability">
                  <div className="metric">
                    {health.state.unknown
                      ? 'Unknown'
                      : health.state.lastOk
                        ? 'Responding'
                        : 'Check failing'}
                  </div>
                  <p>
                    {health.state.last
                      ? `Last probe ${new Date(health.state.last).toLocaleTimeString()}`
                      : 'No verified probe yet'}
                  </p>
                </Card>
                <Card title="Alert authority">
                  <div className="metric">
                    {settings.monitor.authority === 'local' ? 'Local' : 'External'}
                  </div>
                  <p>{settings.monitor.recipients.length} local recipients configured</p>
                </Card>
              </div>
              <div className="grid two">
                <Card title="Access management">
                  <p>
                    Search accounts, review invitations and edit libraries for the selected server.
                    Use reusable presets and preview bulk changes.
                  </p>
                  <button className="secondary" onClick={() => setPage('Users')}>
                    Manage users
                  </button>
                </Card>
                <Card title="Monitoring runs here, not on your phone">
                  <p>
                    The backend checks Plex every {settings.monitor.intervalSeconds} seconds. It
                    declares an outage after {settings.monitor.failureSeconds} seconds of observed
                    continuous failure and confirms recovery after {settings.monitor.recoveryCount}{' '}
                    successful checks.
                  </p>
                  <p className="muted">
                    Local API health does not guarantee remote access or playback. For whole-host,
                    power and internet outages, provision the optional external worker.
                  </p>
                  <button className="secondary" onClick={() => setPage('Monitoring')}>
                    Review monitoring
                  </button>
                </Card>
              </div>
              <Card title="Recent activity">
                <JsonHistory
                  items={health.timeline.slice(0, 6)}
                  columns={[
                    { key: 'at', label: 'Time', date: true },
                    { key: 'event', label: 'Event' },
                  ]}
                />
              </Card>
            </>
          )}
          {page === 'Users' && <Users notice={notice} offline={offline} />}
          {page === 'Settings' && (
            <SettingsPage
              settings={settings}
              refresh={refresh}
              notice={notice}
              offline={offline}
              onLogout={() => setLoggedIn(false)}
            />
          )}
          {page === 'Notifications' && (
            <Notifications
              settings={settings}
              refresh={refresh}
              notice={notice}
              offline={offline}
            />
          )}
          {page === 'Monitoring' && (
            <Monitoring
              settings={settings}
              health={health}
              refresh={refresh}
              notice={notice}
              offline={offline}
            />
          )}
          {page === 'Audit' && (
            <>
              <div className="page-title">
                <h1>Audit history</h1>
                <button className="secondary" onClick={() => void api('/audit').then(setAudit)}>
                  Refresh
                </button>
              </div>
              <Card title="Administrative actions">
                <JsonHistory
                  items={audit}
                  columns={[
                    { key: 'at', label: 'Time', date: true },
                    { key: 'action', label: 'Action' },
                    { key: 'target', label: 'Target' },
                    { key: 'result', label: 'Result' },
                  ]}
                />
              </Card>
            </>
          )}
        </main>
        <footer>
          Installation-owned data · Background checks validate Plex identity, not playback.
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if ('serviceWorker' in navigator)
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
