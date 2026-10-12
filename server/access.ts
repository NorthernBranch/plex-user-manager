import { randomUUID } from 'node:crypto';
import { AppError, safeError } from './errors.js';
import { type PlexAdapter, type PlexUser } from './plex.js';
import { Store } from './store.js';

export class Access {
  private active = false;
  constructor(
    private store: Store,
    private plex: () => PlexAdapter,
    private selected: () => string,
  ) {}
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new AppError(
        409,
        'BUSY',
        'Another access operation is running. Refresh and try again.',
      );
    this.active = true;
    try {
      return await fn();
    } finally {
      this.active = false;
    }
  }
  async snapshot() {
    const server = this.selected(),
      adapter = this.plex();
    const [users, libraries] = await Promise.all([
      adapter.users(server),
      adapter.libraries(server),
    ]);
    return { server, users, libraries };
  }
  async validateLibraries(libraries: string[]) {
    const known = await this.plex().libraries(this.selected());
    if (!libraries.length || libraries.some((id) => !known.some((l) => l.id === id)))
      throw new AppError(
        400,
        'LIBRARIES',
        'Choose at least one current library. Use Revoke to remove all access.',
      );
  }
  async change(userId: string, libraries: string[] | null, expectedShare?: string) {
    try {
      return await this.performChange(userId, libraries, expectedShare);
    } catch (error) {
      this.store.audit(
        libraries === null ? 'access.revoke' : 'access.update',
        userId,
        'failed or unconfirmed',
      );
      throw error;
    }
  }
  private async performChange(userId: string, libraries: string[] | null, expectedShare?: string) {
    const server = this.selected(),
      adapter = this.plex();
    const user = (await adapter.users(server)).find((u) => u.id === userId);
    if (!user) {
      if (libraries === null) return { alreadyAbsent: true };
      throw new AppError(404, 'USER', 'User no longer has access to this server.');
    }
    if (expectedShare && user.shareId !== expectedShare)
      throw new AppError(
        409,
        'CHANGED',
        'Share changed outside this application. Refresh before applying.',
      );
    if (libraries === null) await adapter.revoke(server, user);
    else {
      await this.validateLibraries(libraries);
      await adapter.update(server, user, libraries);
    }
    const after = (await adapter.users(server)).find((u) => u.id === userId);
    if (
      libraries === null
        ? Boolean(after)
        : !after || [...after.libraries].sort().join(',') !== [...libraries].sort().join(',')
    )
      throw new AppError(
        502,
        'RECONCILE',
        'Plex has not confirmed the requested state. Refresh; do not assume success.',
      );
    this.store.audit(libraries === null ? 'access.revoke' : 'access.update', userId, 'confirmed');
    return { confirmed: true };
  }
  async invite(identity: string, libraries: string[]) {
    await this.validateLibraries(libraries);
    try {
      await this.plex().users(this.selected());
      await this.plex().invite(this.selected(), identity, libraries);
      await this.plex().users(this.selected());
      this.store.audit(
        'access.invite',
        identity,
        'Plex accepted; refreshed. Check pending invitations.',
      );
    } catch (error) {
      this.store.audit('access.invite', identity, 'failed or unconfirmed');
      throw error;
    }
  }
  async preview(users: string[], libraries: string[]) {
    await this.validateLibraries(libraries);
    const snapshot = await this.snapshot();
    const plan = users.map((id) => {
      const user = snapshot.users.find((u) => u.id === id);
      if (!user) throw new AppError(409, 'CHANGED', 'One selected user no longer has access.');
      return {
        id,
        shareId: user.shareId,
        name: user.name,
        before: user.libraries,
        after: libraries,
      };
    });
    const ticket = randomUUID();
    this.store.set(`bulk:${ticket}`, {
      server: snapshot.server,
      expires: Date.now() + 300000,
      plan,
    });
    return { ticket, plan };
  }
  async apply(ticket: string) {
    const preview = this.store.get<{
      server: string;
      expires: number;
      plan: { id: string; shareId: string; before: string[]; after: string[] }[];
    }>(`bulk:${ticket}`);
    if (!preview || preview.expires < Date.now() || preview.server !== this.selected())
      throw new AppError(409, 'PREVIEW', 'Preview expired or server changed. Preview again.');
    this.store.run('DELETE FROM kv WHERE key=?', `bulk:${ticket}`);
    const results = [];
    for (const entry of preview.plan) {
      try {
        const current = (await this.plex().users(this.selected())).find((u) => u.id === entry.id);
        if (
          !current ||
          current.shareId !== entry.shareId ||
          [...current.libraries].sort().join() !== [...entry.before].sort().join()
        )
          throw new AppError(409, 'CHANGED', 'Access changed since preview. Skipped.');
        await this.change(entry.id, entry.after, entry.shareId);
        results.push({ id: entry.id, ok: true });
      } catch (error) {
        this.store.audit('access.bulk', entry.id, 'failed or unconfirmed');
        results.push({ id: entry.id, ok: false, error: safeError(error) });
      }
    }
    return results;
  }
  async expire(now = Date.now()) {
    if (this.active) return;
    await this.exclusive(async () => {
      const due = this.store.all<{ server: string; user: string; attempts: number }>(
        'SELECT * FROM expiries WHERE status IN (?,?) AND due<=? AND next<=?',
        'pending',
        'running',
        now,
        now,
      );
      for (const row of due) {
        if (row.server !== this.selected()) continue;
        this.store.run(
          'UPDATE expiries SET status=? WHERE server=? AND user=?',
          'running',
          row.server,
          row.user,
        );
        try {
          await this.change(row.user, null);
          this.store.run(
            'UPDATE expiries SET status=?,error=NULL WHERE server=? AND user=?',
            'done',
            row.server,
            row.user,
          );
        } catch (error) {
          const attempts = row.attempts + 1;
          this.store.run(
            'UPDATE expiries SET status=?,attempts=?,next=?,error=? WHERE server=? AND user=?',
            attempts >= 5 ? 'failed' : 'pending',
            attempts,
            now + Math.min(3600000, 60000 * 2 ** attempts),
            safeError(error),
            row.server,
            row.user,
          );
          this.store.audit('expiry', row.user, 'failed or unconfirmed');
        }
      }
    });
  }
}
export function sameLibraries(a: PlexUser, b: PlexUser) {
  return a.libraries.slice().sort().join() === b.libraries.slice().sort().join();
}
