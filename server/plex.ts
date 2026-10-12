import { randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { AppError } from './errors.js';
import { serializeFilters } from './filters.js';

const id = z.union([z.string().min(1), z.number().int()]).transform(String);
const flag = z
  .union([z.boolean(), z.number(), z.string()])
  .transform((v) => v === true || v === 1 || v === '1' || v === 'true');
const resourceSchema = z.object({
  clientIdentifier: id,
  name: z.string(),
  owned: flag,
  provides: z.string(),
  accessToken: z.string().min(1),
  connections: z.array(z.object({ uri: z.url(), local: flag.optional() })),
});
const librarySchema = z.object({ id, key: id, title: z.string(), type: z.string() });
const shareSchema = z.object({
  id,
  machineIdentifier: id,
  pending: flag.optional(),
  allLibraries: flag.optional(),
});
const userSchema = z.object({
  id,
  title: z.string().optional(),
  username: z.string().optional(),
  email: z.string().optional(),
  restricted: flag.optional(),
  Server: z.unknown().optional(),
  filterMovies: z.string().optional(),
  filterTelevision: z.string().optional(),
  filterMusic: z.string().optional(),
});
export type OwnedServer = { id: string; name: string; connections: string[]; token: string };
export type Library = { id: string; key: string; title: string; type: string };
export type PlexUser = {
  id: string;
  name: string;
  kind: 'shared' | 'managed' | 'pending';
  shareId: string;
  libraries: string[];
  filters: Record<string, string>;
};
export type SelectedServer = { id: string; name: string; url: string; token: string };
export type Restrictions = {
  movies: { ratings: string[]; labels: string[] };
  television: { ratings: string[]; labels: string[] };
  music: { labels: string[] };
};
export const restrictionsSchema = z.object({
  movies: z.object({
    ratings: z.array(z.string().min(1).max(80)).max(50),
    labels: z.array(z.string().min(1).max(80)).max(50),
  }),
  television: z.object({
    ratings: z.array(z.string().min(1).max(80)).max(50),
    labels: z.array(z.string().min(1).max(80)).max(50),
  }),
  music: z.object({ labels: z.array(z.string().min(1).max(80)).max(50) }),
});
export interface PlexAdapter {
  ownedServers(): Promise<OwnedServer[]>;
  account(): Promise<{ plexPass: boolean }>;
  libraries(server: string): Promise<Library[]>;
  users(server: string): Promise<PlexUser[]>;
  invite(server: string, identity: string, libraries: string[]): Promise<void>;
  update(server: string, user: PlexUser, libraries: string[]): Promise<void>;
  revoke(server: string, user: PlexUser): Promise<void>;
  restrictions(user: string, values: Restrictions): Promise<void>;
  probe(server: SelectedServer, timeoutMs: number): Promise<void>;
}
function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function record(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new AppError(502, 'PLEX_SCHEMA', 'Plex response does not match the supported API shape.');
  return parsed.data;
}
export class Plex implements PlexAdapter {
  constructor(
    public token: string,
    public clientId: string = randomUUID(),
    private fetcher: typeof fetch = fetch,
  ) {}
  async request(
    url: string,
    method = 'GET',
    body?: unknown,
    token = this.token,
    timeoutMs = 10000,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < (method === 'GET' ? 3 : 1); attempt++) {
      try {
        const response = await this.fetcher(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: /^\/api\/(users|servers|invites)(\/|$)/.test(new URL(url).pathname)
              ? 'application/xml'
              : 'application/json',
            'X-Plex-Product': 'Plex User Manager',
            'X-Plex-Client-Identifier': this.clientId,
            ...(token ? { 'X-Plex-Token': token } : {}),
            ...(body
              ? {
                  'Content-Type':
                    body instanceof URLSearchParams
                      ? 'application/x-www-form-urlencoded'
                      : 'application/json',
                }
              : {}),
          },
          ...(body
            ? { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) }
            : {}),
        });
        if (!response.ok) {
          if (
            method === 'GET' &&
            (response.status === 429 || response.status >= 500) &&
            attempt < 2
          ) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          throw new AppError(
            502,
            'PLEX_HTTP',
            `Plex returned HTTP ${response.status}. Refresh and check connection or account permissions.`,
          );
        }
        const text = await response.text();
        if (text.length > 4_000_000)
          throw new AppError(502, 'PLEX_RESPONSE', 'Plex response exceeded the safe size limit.');
        if (!text.trim()) return {};
        try {
          if (text.trim().startsWith('<')) {
            if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
              throw new Error();
            return new XMLParser({
              ignoreAttributes: false,
              attributeNamePrefix: '',
              parseAttributeValue: false,
              processEntities: true,
            }).parse(text);
          }
          return JSON.parse(text);
        } catch {
          throw new AppError(
            502,
            'PLEX_RESPONSE',
            'Plex returned an invalid response. No change is assumed successful.',
          );
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (method === 'GET' && attempt < 2) continue;
        throw new AppError(
          502,
          'PLEX_NETWORK',
          'Plex request failed or timed out. A mutation may have been accepted; refresh before retrying.',
        );
      }
    }
    throw new AppError(502, 'PLEX_NETWORK', 'Plex is unavailable.');
  }
  private async validate<T>(schema: z.ZodType<T>, value: unknown): Promise<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new AppError(
        502,
        'PLEX_SCHEMA',
        'Plex response does not match the supported API shape. Check the integration compatibility guide.',
      );
    return parsed.data;
  }
  async pin() {
    const pin = await this.validate(
      z.object({ id: z.number().int(), code: z.string().min(1) }),
      await this.request(
        'https://plex.tv/api/v2/pins',
        'POST',
        new URLSearchParams({ strong: 'true' }),
      ),
    );
    const args = new URLSearchParams({
      clientID: this.clientId,
      code: pin.code,
      'context[device][product]': 'Plex User Manager',
    });
    return { id: pin.id, url: `https://app.plex.tv/auth#?${args.toString()}` };
  }
  async poll(id: number) {
    return this.validate(
      z.object({ authToken: z.string().nullable().optional() }),
      await this.request(`https://plex.tv/api/v2/pins/${id}`),
    );
  }
  async account() {
    const a = await this.validate(
      z.object({ subscription: z.object({ active: flag }) }),
      await this.request('https://plex.tv/api/v2/user'),
    );
    return { plexPass: a.subscription.active };
  }
  async ownedServers() {
    const items = await this.validate(
      z.array(resourceSchema),
      await this.request('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0'),
    );
    return items
      .filter((x) => x.owned && x.provides.split(',').includes('server'))
      .map((x) => ({
        id: x.clientIdentifier,
        name: x.name,
        token: x.accessToken,
        connections: x.connections.map((c) => c.uri).filter(validServerUrl),
      }));
  }
  private path(server: string) {
    return `https://plex.tv/api/servers/${encodeURIComponent(server)}`;
  }
  async libraries(server: string) {
    const response = record(await this.request(this.path(server)));
    try {
      const container = record(response.MediaContainer ?? response);
      const servers = list(container.Server);
      const parent = record(servers[0] ?? container);
      return await this.validate(z.array(librarySchema), list(parent.Section));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'PLEX_SCHEMA', 'Plex library response is unsupported.');
    }
  }
  async users(server: string) {
    const responses = await Promise.all([
      this.request('https://plex.tv/api/users/'),
      this.request('https://plex.tv/api/invites/requested'),
    ]);
    const result: PlexUser[] = [];
    for (let i = 0; i < responses.length; i++) {
      const response = record(responses[i]);
      const container = record(
        response.MediaContainer === '' ? {} : (response.MediaContainer ?? response),
      );
      const users = await this.validate(
        z.array(userSchema),
        list(container[i === 0 ? 'User' : 'Invite']),
      );
      for (const user of users) {
        const shares = await this.validate(z.array(shareSchema), list(user.Server));
        const share = shares.find((s) => s.machineIdentifier === server);
        if (!share) continue;
        const detail = record(
          await this.request(`${this.path(server)}/shared_servers/${encodeURIComponent(share.id)}`),
        );
        const d = record(detail.MediaContainer ?? detail),
          shared = record(list(d.SharedServer)[0] ?? d);
        const sections = await this.validate(
          z.array(z.object({ id, shared: flag })),
          list(shared.Section),
        );
        const libraries = sections.filter((s) => s.shared).map((s) => s.id);
        result.push({
          id: user.id,
          name: user.username || user.title || user.email || `Account ${user.id}`,
          kind: i === 1 || share.pending ? 'pending' : user.restricted ? 'managed' : 'shared',
          shareId: share.id,
          libraries,
          filters: {
            filterMovies: user.filterMovies ?? '',
            filterTelevision: user.filterTelevision ?? '',
            filterMusic: user.filterMusic ?? '',
          },
        });
      }
    }
    return [...new Map(result.map((u) => [u.shareId, u])).values()];
  }
  async invite(server: string, identity: string, libraries: string[]) {
    await this.request(`${this.path(server)}/shared_servers`, 'POST', {
      server_id: server,
      shared_server: { library_section_ids: libraries, invited_email: identity },
    });
  }
  async update(server: string, user: PlexUser, libraries: string[]) {
    await this.request(
      `${this.path(server)}/shared_servers/${encodeURIComponent(user.shareId)}`,
      'PUT',
      { server_id: server, shared_server: { library_section_ids: libraries } },
    );
  }
  async revoke(_server: string, user: PlexUser) {
    await this.request(
      `https://plex.tv/api/v2/shared_servers/${encodeURIComponent(user.shareId)}`,
      'DELETE',
    );
  }
  async restrictions(user: string, values: Restrictions) {
    const args = new URLSearchParams(serializeFilters(values));
    await this.request(
      `https://plex.tv/api/v2/sharings/${encodeURIComponent(user)}?${args}`,
      'PUT',
    );
  }
  async probe(server: SelectedServer, timeoutMs: number) {
    // One attempt: retries would distort monitoring thresholds and timeout semantics.
    let response: Response;
    try {
      response = await this.fetcher(`${server.url.replace(/\/$/, '')}/identity`, {
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'X-Plex-Token': server.token },
      });
    } catch {
      throw new AppError(502, 'PLEX_PROBE', 'Plex probe timed out or could not connect.');
    }
    if (!response.ok)
      throw new AppError(502, 'PLEX_PROBE', 'Plex probe returned a failing status.');
    const text = await response.text();
    let raw: unknown;
    try {
      if (text.length > 100000 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error();
      raw = text.trim().startsWith('<')
        ? new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
            processEntities: true,
          }).parse(text)
        : JSON.parse(text);
    } catch {
      throw new AppError(502, 'PLEX_PROBE', 'Probe did not return a Plex identity.');
    }
    const container = record(raw).MediaContainer;
    const identity = await this.validate(
      z.object({ machineIdentifier: z.string(), version: z.string().min(1) }),
      container,
    );
    if (identity.machineIdentifier !== server.id)
      throw new AppError(502, 'PLEX_IDENTITY', 'Probe reached a different Plex server.');
  }
}
export function validServerUrl(value: string) {
  try {
    const u = new URL(value);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ['', '/'].includes(u.pathname)
    );
  } catch {
    return false;
  }
}
