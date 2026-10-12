import { useEffect, useState } from 'react';
import { api } from './api';
import { Badge, Field, Libraries } from './components';
import type { Notice, Snapshot, User } from './types';
import { RestrictionsEditor } from './restrictions-editor';
import { ContactEditor } from './contact-editor';
export function UserEditor({
  user,
  data,
  offline,
  notice,
  close,
  refresh,
}: {
  user: User;
  data: Snapshot;
  offline: boolean;
  notice: Notice;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [libs, setLibs] = useState(user.libraries),
    [notes, setNotes] = useState(user.notes),
    [expires, setExpires] = useState(
      user.expiry ? new Date(user.expiry.due).toISOString().slice(0, 16) : '',
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [welcome, setWelcome] = useState<{ subject: string; body: string }>(),
    [testRecipient, setTestRecipient] = useState('');
  async function run(fn: () => Promise<void | false>) {
    setBusy(true);
    setError('');
    try {
      if ((await fn()) === false) return;
      await refresh();
      notice('Operation completed. Current Plex state refreshed.');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const dialog = document.getElementById('user-dialog') as HTMLDialogElement;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const restrictionsEnabled = data.capabilities.plexPass && user.kind === 'shared';
  return (
    <dialog id="user-dialog" onCancel={close} aria-labelledby="editor-title">
      <div className="dialog-head">
        <div>
          <p className="eyebrow">SELECTED SERVER ACCESS</p>
          <h2 id="editor-title">{user.name}</h2>
        </div>
        <button className="secondary" onClick={close} aria-label="Close user editor">
          Close
        </button>
      </div>
      <Badge>{user.kind}</Badge>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Libraries libraries={data.libraries} value={libs} onChange={setLibs} />
      <button
        disabled={offline || busy || !libs.length}
        onClick={() =>
          void run(async () => {
            await api(
              `/users/${user.id}/access`,
              { libraries: libs, shareId: user.shareId },
              'PUT',
            );
          })
        }
      >
        Save library access
      </button>
      <hr />
      <Field label="Private administrator notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10000} />
      </Field>
      <Field
        label="Access expiry (UTC)"
        hint={
          user.kind === 'pending'
            ? 'Expiry is available after the invitation is accepted.'
            : 'Revokes only this server’s share. An overdue expiry runs after restart. Failed jobs appear in Monitoring.'
        }
      >
        <input
          type="datetime-local"
          value={expires}
          disabled={user.kind === 'pending'}
          onChange={(e) => setExpires(e.target.value)}
        />
      </Field>
      <button
        className="secondary"
        disabled={offline || busy}
        onClick={() =>
          void run(async () => {
            const original = user.expiry
              ? new Date(user.expiry.due).toISOString().slice(0, 16)
              : '';
            if (
              expires &&
              expires !== original &&
              !confirm(
                'Schedule revocation of access to this server at the selected UTC time? Other server shares and Plex Home membership remain.',
              )
            )
              return false as const;
            await api(
              `/users/${user.id}/metadata`,
              { notes, expires: expires ? new Date(`${expires}:00Z`).toISOString() : null },
              'PUT',
            );
          })
        }
      >
        Save notes & expiry
      </button>
      <hr />
      <ContactEditor
        contact={user.contact}
        userId={user.id}
        pending={user.kind === 'pending'}
        offline={offline || busy}
        onSaved={refresh}
      />
      <h3>Welcome message</h3>
      <p>
        Automatic welcome requires an observed pending-to-accepted transition with the same account
        and share IDs. Existing users are not automatically welcomed. This explicit send does not
        infer invitation acceptance.
      </p>
      <button
        className="secondary"
        disabled={offline || busy || user.kind === 'pending'}
        onClick={() =>
          void run(async () => {
            setWelcome(await api(`/users/${user.id}/welcome/preview`, {}));
            return false as const;
          })
        }
      >
        Preview welcome
      </button>
      {welcome && (
        <div className="preview">
          <h4>{welcome.subject}</h4>
          <p className="plain-text">{welcome.body}</p>
          <Field label="Welcome test recipient">
            <input
              type="email"
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value)}
            />
          </Field>
          <button
            className="secondary"
            disabled={offline || busy || !testRecipient}
            onClick={() =>
              void run(async () => {
                await api(`/users/${user.id}/welcome/test`, {
                  recipient: testRecipient,
                  confirm: true,
                });
                notice('Welcome test queued.');
              })
            }
          >
            Queue welcome test
          </button>
          <button
            disabled={offline || busy}
            onClick={() => {
              if (confirm('Queue an explicit welcome/resend to the verified, eligible contact?'))
                void run(async () => {
                  await api(`/users/${user.id}/welcome`, {
                    requestId: crypto.randomUUID(),
                    confirm: true,
                  });
                });
            }}
          >
            Confirm welcome send/resend
          </button>
        </div>
      )}
      <hr />
      <h3>Content restrictions</h3>
      <p>{data.capabilities.restrictionScope}</p>
      <p>
        {!data.capabilities.plexPass
          ? 'Plex Pass required.'
          : user.kind !== 'shared'
            ? 'Use Plex Web for this account type.'
            : 'This changes account sharing restrictions across your servers. Review the existing filters before replacing them.'}
      </p>
      <dl>
        {Object.entries(user.filters).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value || 'None'}</dd>
          </div>
        ))}
      </dl>
      <RestrictionsEditor
        filters={user.filters}
        disabled={!restrictionsEnabled || offline || busy}
        onApply={(values) =>
          void run(async () => {
            const result = await api(`/users/${user.id}/restrictions`, {
              confirmAccountScope: true,
              expectedFilters: {
                filterMovies: user.filters.filterMovies ?? '',
                filterTelevision: user.filters.filterTelevision ?? '',
                filterMusic: user.filters.filterMusic ?? '',
              },
              values,
            });
            notice(result.message);
          })
        }
      />
      <hr />
      <button
        className="danger"
        disabled={offline || busy}
        onClick={() => {
          if (
            confirm(
              `Revoke ${user.name}'s access to this server? Their other shares, friendships and Plex Home membership will remain.`,
            )
          )
            void run(async () => {
              await api(
                `/users/${user.id}/access`,
                { confirm: true, shareId: user.shareId },
                'DELETE',
              );
            });
        }}
      >
        Revoke server access
      </button>
    </dialog>
  );
}
