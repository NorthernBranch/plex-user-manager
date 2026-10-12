import { useState } from 'react';
import { api } from './api';
import { Card, Field } from './components';
import type { Notice, Settings, OwnedServerPublic } from './types';
export function SettingsPage({
  settings,
  refresh,
  notice,
  offline,
  onLogout,
}: {
  settings: Settings;
  refresh: () => Promise<void>;
  notice: Notice;
  offline: boolean;
  onLogout: () => void;
}) {
  const [servers, setServers] = useState<OwnedServerPublic[]>([]),
    [serverId, setServerId] = useState(settings.server?.id ?? ''),
    [url, setUrl] = useState(settings.server?.url ?? ''),
    [pin, setPin] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
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
          <p className="eyebrow">INSTALLATION</p>
          <h1>Settings & integration</h1>
          <p>Your application login, Plex account and selected Media Server are separate.</p>
        </div>
      </div>
      <div className="grid two">
        <Card title="1. Connect your Plex account">
          <p>
            {settings.plexConnected
              ? 'Plex owner account connected.'
              : 'Sign in on Plex’s own website. This app never asks for your Plex password.'}
          </p>
          <button
            disabled={offline || busy || settings.plexConnected}
            onClick={() =>
              void run(async () => {
                const result = await api('/plex/pin', {});
                setPin(result.url);
              })
            }
          >
            Start Plex sign-in
          </button>
          {pin && (
            <div className="preview">
              <a href={pin} target="_blank" rel="noreferrer" className="button">
                Open Plex sign-in
              </a>
              <p>Complete sign-in, return here, then check the connection.</p>
              <button
                className="secondary"
                disabled={offline || busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api('/plex/poll', {});
                    notice(
                      result.connected
                        ? 'Plex connected. Load your owned servers next.'
                        : 'Waiting for Plex sign-in.',
                    );
                    if (result.connected) setPin('');
                  })
                }
              >
                Check sign-in
              </button>
            </div>
          )}
          {settings.plexConnected && (
            <button
              className="text-button danger"
              disabled={offline || busy}
              onClick={() => {
                if (
                  confirm(
                    'Disconnect Plex? Monitoring and expiry jobs pause until you reconnect and select a server.',
                  )
                )
                  void run(async () => {
                    await api('/plex/disconnect', { confirm: true });
                    notice('Integration disconnected.');
                  });
              }}
            >
              Disconnect integration
            </button>
          )}
        </Card>
        <Card title="2. Select & test an owned server">
          <button
            className="secondary"
            disabled={offline || busy || !settings.plexConnected}
            onClick={() => void run(async () => setServers(await api('/plex/servers')))}
          >
            Load owned servers
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const switching = !!settings.server && settings.server.id !== serverId;
                if (
                  switching &&
                  !confirm('Switch servers? Expiry jobs stay tied to their original server.')
                )
                  return;
                await api('/plex/server', { id: serverId, url, confirmSwitch: switching });
                notice('Owned server selected and Plex identity verified.');
              });
            }}
          >
            <Field label="Owned server">
              <select
                value={serverId}
                required
                onChange={(e) => {
                  setServerId(e.target.value);
                  setUrl(servers.find((s) => s.id === e.target.value)?.connections[0] ?? '');
                }}
              >
                <option value="">Choose a server</option>
                {settings.server && !servers.some((s) => s.id === settings.server!.id) && (
                  <option value={settings.server.id}>{settings.server.name}</option>
                )}
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Backend connection URL"
              hint="Use a reachable HTTP(S) Plex origin. A custom local address must identify the same owned server."
            >
              <input
                type="url"
                value={url}
                required
                onChange={(e) => setUrl(e.target.value)}
                list="connections"
                placeholder="http://NAS_ADDRESS:32400"
              />
              <datalist id="connections">
                {servers
                  .find((s) => s.id === serverId)
                  ?.connections.map((uri: string) => (
                    <option key={uri} value={uri} />
                  ))}
              </datalist>
            </Field>
            <button disabled={offline || busy || !serverId}>Test & select server</button>
          </form>
          {settings.server && (
            <button
              className="secondary"
              disabled={offline || busy}
              onClick={() =>
                void run(async () => {
                  const result = await api('/plex/test', {});
                  notice(result.scope);
                })
              }
            >
              Test current connection
            </button>
          )}
        </Card>
        <Card title="Public URL & security">
          <p>
            Configured public origin: <strong>{settings.publicUrl}</strong>
          </p>
          <p>
            Set PUBLIC_URL and narrowly scoped TRUSTED_PROXY in deployment configuration. Public
            HTTPS uses secure, HttpOnly session cookies. Sessions expire after eight hours.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api('/password', { current: f.get('current'), password: f.get('password') });
                onLogout();
              });
            }}
          >
            <Field label="Current administrator password">
              <input name="current" type="password" autoComplete="current-password" required />
            </Field>
            <Field label="New password">
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
              />
            </Field>
            <button className="secondary" disabled={offline || busy}>
              Change password & end sessions
            </button>
          </form>
        </Card>
        <Card title="Optional external monitoring">
          <p>
            A worker outside your home network can detect missed heartbeats and send emails
            independently. Provision its SMTP settings and recipients before an outage.
          </p>
          <p>
            Set notification authority to External in Monitoring to prevent the local and external
            workers sending duplicate alerts. The worker does not receive a Plex owner token.
          </p>
          <p role="status">
            Last heartbeat:{' '}
            {settings.heartbeatDelivery?.at
              ? `${settings.heartbeatDelivery.ok ? 'Accepted' : 'Failed'} at ${new Date(settings.heartbeatDelivery.at).toLocaleString()}`
              : 'Not yet accepted'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void run(async () => {
                await api('/heartbeat', { url: f.get('url'), key: f.get('key') });
                notice(
                  'Heartbeat configured. Wait for worker delivery status before selecting external authority.',
                );
              });
            }}
          >
            <Field label="External worker heartbeat URL">
              <input
                name="url"
                type="url"
                defaultValue={settings.heartbeat?.url ?? ''}
                placeholder="https://monitor.example.com/heartbeat"
                required
              />
            </Field>
            <Field
              label="Shared heartbeat key"
              hint={
                settings.heartbeat?.hasKey
                  ? 'Leave blank to retain the stored key.'
                  : 'Use the random key provisioned on the worker.'
              }
            >
              <input
                name="key"
                type="password"
                autoComplete="off"
                minLength={32}
                required={!settings.heartbeat?.hasKey}
              />
            </Field>
            <button className="secondary" disabled={offline || busy}>
              Save heartbeat connection
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}
