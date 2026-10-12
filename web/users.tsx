import { useEffect, useState } from 'react';
import { api } from './api';
import { Badge, Card, Field, Libraries } from './components';
import type { Notice, Snapshot, User, Preset, BulkPreview, BulkResult } from './types';
import { UserEditor } from './user-editor';

export function Users({ notice, offline }: { notice: Notice; offline: boolean }) {
  const [data, setData] = useState<Snapshot>(),
    [query, setQuery] = useState(''),
    [sort, setSort] = useState('name'),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<User>(),
    [libs, setLibs] = useState<string[]>([]),
    [preview, setPreview] = useState<BulkPreview>(),
    [presets, setPresets] = useState<Preset[]>([]),
    [results, setResults] = useState<BulkResult[]>([]),
    [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      setData(await api('/users'));
      setPresets(await api('/presets'));
    } catch (e) {
      notice((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
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
  if (!data)
    return (
      <Card title="Users and invitations">
        <p>Connect and select a server in Settings to load current Plex access.</p>
        <button className="secondary" onClick={() => void refresh()}>
          Refresh
        </button>
      </Card>
    );
  const visible = data.users
    .filter((u) => u.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === 'access'
        ? b.libraries.length - a.libraries.length
        : sort === 'kind'
          ? a.kind.localeCompare(b.kind)
          : a.name.localeCompare(b.name),
    );
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">ACCESS MANAGEMENT</p>
          <h1>Users & invitations</h1>
          <p>{data.users.length} accounts · Refreshed directly from Plex</p>
        </div>
        <button className="secondary" onClick={() => void refresh()} disabled={offline || busy}>
          Refresh from Plex
        </button>
      </div>
      <Card title="Server access">
        <div className="toolbar">
          <Field label="Search users">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name"
            />
          </Field>
          <Field label="Sort">
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="name">Name</option>
              <option value="access">Library count</option>
              <option value="kind">Account type</option>
            </select>
          </Field>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Select</th>
                <th scope="col">Account</th>
                <th scope="col">Type</th>
                <th scope="col">Access</th>
                <th scope="col">Expiry</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.shareId}>
                  <td>
                    <input
                      aria-label={`Select ${u.name}`}
                      type="checkbox"
                      checked={selected.includes(u.id)}
                      onChange={(e) => {
                        setSelected(
                          e.target.checked
                            ? [...selected, u.id]
                            : selected.filter((id) => id !== u.id),
                        );
                        setPreview(undefined);
                      }}
                    />
                  </td>
                  <td>
                    <button className="text-button" onClick={() => setDetail(u)}>
                      {u.name}
                    </button>
                  </td>
                  <td>
                    <Badge tone={u.kind === 'pending' ? 'warning' : 'neutral'}>{u.kind}</Badge>
                  </td>
                  <td>
                    {u.libraries
                      .map(
                        (id) => data.libraries.find((l) => l.id === id)?.title ?? `Library ${id}`,
                      )
                      .join(', ') || 'No libraries'}
                  </td>
                  <td>
                    {u.expiry
                      ? `${new Date(u.expiry.due).toLocaleDateString()} · ${u.expiry.status}`
                      : 'No expiry'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && <p className="empty">No users match. Invite an account below.</p>}
        <p className="muted">
          Managed accounts are listed when Plex exposes their shares. Creation, Plex Home membership
          and managed-account restrictions remain in Plex Web.
        </p>
      </Card>
      <div className="grid two">
        <Card title="Invite an account">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                const result = await api('/invitations', {
                  identity: form.get('identity'),
                  libraries: libs,
                });
                notice(result.message);
              });
            }}
          >
            <Field label="Plex username or email">
              <input name="identity" required maxLength={254} />
            </Field>
            <Libraries
              libraries={data.libraries}
              value={libs}
              onChange={(v) => {
                setLibs(v);
                setPreview(undefined);
              }}
            />
            <button disabled={offline || busy || !libs.length}>Send invitation</button>
          </form>
        </Card>
        <Card title="Bulk access & presets">
          <Field label="Apply a saved preset">
            <select
              defaultValue=""
              onChange={(e) => {
                setLibs(presets.find((p) => p.id === e.target.value)?.libraries ?? []);
                setPreview(undefined);
              }}
            >
              <option value="">Choose a preset</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <p>
            Selected libraries in the invitation panel also define the bulk change.{' '}
            {selected.length} users selected.
          </p>
          <button
            className="secondary"
            disabled={offline || busy || !selected.length || !libs.length}
            onClick={() =>
              void action(async () =>
                setPreview(await api('/bulk/preview', { users: selected, libraries: libs })),
              )
            }
          >
            Preview bulk change
          </button>
          {preview && (
            <div className="preview">
              <h3>Review changes</h3>
              {preview.plan.map((p) => (
                <p key={p.id}>
                  <strong>{p.name}</strong>
                  <br />
                  Before:{' '}
                  {p.before
                    .map((id) => data.libraries.find((l) => l.id === id)?.title ?? id)
                    .join(', ') || 'No libraries'}
                  <br />
                  After:{' '}
                  {p.after
                    .map((id) => data.libraries.find((l) => l.id === id)?.title ?? id)
                    .join(', ')}
                </p>
              ))}
              <p>Only the selected server is affected. Changed shares will be skipped.</p>
              <button
                disabled={offline || busy}
                onClick={() =>
                  void action(async () => {
                    setResults(await api('/bulk/apply', { ticket: preview.ticket, confirm: true }));
                    setPreview(undefined);
                  })
                }
              >
                Confirm bulk change
              </button>
            </div>
          )}
          {results.map((r) => (
            <p key={r.id} role="status">
              Account {r.id}: {r.ok ? 'Confirmed' : r.error}
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action(async () => {
                await api('/presets', { name: f.get('name'), libraries: libs });
                notice('Preset saved.');
              });
            }}
          >
            <Field label="Save selected libraries as preset">
              <input name="name" required maxLength={80} />
            </Field>
            <button className="secondary" disabled={offline || busy || !libs.length}>
              Save preset
            </button>
          </form>
          {presets.map((p) => (
            <p key={p.id}>
              {p.name}{' '}
              <button
                className="text-button danger"
                disabled={offline || busy}
                onClick={() => {
                  if (confirm('Delete this app-owned preset?'))
                    void action(async () => {
                      await api(`/presets/${p.id}`, {}, 'DELETE');
                    });
                }}
              >
                Delete
              </button>
            </p>
          ))}
        </Card>
      </div>
      {detail && (
        <UserEditor
          key={detail.shareId}
          user={detail}
          data={data}
          offline={offline}
          notice={notice}
          close={() => setDetail(undefined)}
          refresh={refresh}
        />
      )}
    </>
  );
}
