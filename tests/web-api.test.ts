import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrf } from '../web/api.js';
import { readJsonResponse } from '../web/response.js';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrf('');
});

describe('API responses behind a reverse proxy', () => {
  it.each([502, 503, 504, 520, 522])(
    'reports an HTML gateway error at HTTP %i safely',
    async (status) => {
      const response = new Response('<!DOCTYPE html><title>Synthetic gateway error</title>', {
        status,
        headers: { 'Content-Type': 'text/html' },
      });
      await expect(readJsonResponse(response)).rejects.toThrow(`HTTP ${status}`);
      expect(response.bodyUsed).toBe(false);
    },
  );

  it('rejects a successful HTML sign-in page rather than returning an API result', async () => {
    await expect(
      readJsonResponse(new Response('<!DOCTYPE html><title>Synthetic sign-in</title>')),
    ).rejects.toThrow('unexpected response (HTTP 200)');
  });

  it.each([401, 403])('explains an HTML authentication failure at HTTP %i', async (status) => {
    await expect(
      readJsonResponse(new Response('<html>Sign in</html>', { status })),
    ).rejects.toThrow('Reload to sign in');
  });

  it('rejects redirects before consuming a sign-in page', async () => {
    const response = new Response('<html>Sign in</html>');
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    await expect(readJsonResponse(response)).rejects.toThrow('Sign-in redirected');
    expect(response.bodyUsed).toBe(false);
    const followed = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(followed, 'redirected', { value: true });
    await expect(readJsonResponse(followed)).rejects.toThrow('Sign-in redirected');
  });

  it('preserves the safe backend error that explains a Plex integration failure', async () => {
    await expect(
      readJsonResponse(
        Response.json(
          { code: 'PLEX_SCHEMA', error: 'Plex collection response is missing its envelope.' },
          { status: 502 },
        ),
      ),
    ).rejects.toThrow('Plex collection response is missing its envelope.');
  });

  it('handles malformed JSON without exposing body text', async () => {
    await expect(
      readJsonResponse(
        new Response('synthetic-private-response', {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ).rejects.toThrow('unexpected response (HTTP 200)');
  });

  it('accepts valid JSON and structured JSON content types', async () => {
    expect(await readJsonResponse(Response.json({ users: [] }))).toEqual({ users: [] });
    expect(
      await readJsonResponse(
        new Response('{"ok":true}', {
          headers: { 'Content-Type': 'application/vnd.example+json; charset=utf-8' },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('never retries a failed mutation or follows a proxy sign-in redirect', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    setCsrf('synthetic-csrf');
    await expect(
      api('/users/11/access', { shareId: '101', confirm: true }, 'DELETE'),
    ).rejects.toThrow('HTTP 502');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      '/api/users/11/access',
      expect.objectContaining({
        redirect: 'manual',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-CSRF-Token': 'synthetic-csrf',
        }),
      }),
    ]);
  });
});
