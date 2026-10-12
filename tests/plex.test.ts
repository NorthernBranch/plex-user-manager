import { describe, it, expect, vi } from 'vitest';
import { Plex } from '../server/plex.js';
const respond = (value: unknown, status = 200) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
describe('Plex adapter validation', () => {
  it('filters resources to actually owned servers and strips tokens at the app boundary', async () => {
    const resource = {
      clientIdentifier: 'synthetic',
      name: 'Sample server',
      owned: 1,
      provides: 'server',
      accessToken: 'synthetic-test-token',
      connections: [{ uri: 'http://localhost:32400', local: 1 }],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        respond([resource, { ...resource, clientIdentifier: 'shared', owned: 0 }]),
      );
    const plex = new Plex('synthetic-account-token', 'test-client', fetcher);
    expect((await plex.ownedServers()).map((s) => s.id)).toEqual(['synthetic']);
    const options = fetcher.mock.calls[0][1]!;
    expect((options.headers as Record<string, string>)['X-Plex-Token']).toBe(
      'synthetic-account-token',
    );
    expect(fetcher.mock.calls[0][0]).not.toContain('token');
  });
  it('rejects malformed account and resource responses', async () => {
    const plex = new Plex(
      '',
      'test-client',
      vi.fn<typeof fetch>().mockImplementation(async () => respond({ unexpected: true })),
    );
    await expect(plex.ownedServers()).rejects.toMatchObject({ code: 'PLEX_SCHEMA' });
    await expect(plex.account()).rejects.toMatchObject({ code: 'PLEX_SCHEMA' });
  });
  it.each([
    {},
    { User: [] },
    { MediaContainer: null },
    { MediaContainer: [] },
    { MediaContainer: { size: 1 } },
    { MediaContainer: { size: 'invalid', User: [] } },
    { MediaContainer: { size: 0, Error: { message: 'Synthetic error' } } },
    { MediaContainer: { size: 0, Error: 'Synthetic error' } },
    { MediaContainer: { size: 0, unexpected: true } },
    { MediaContainer: { User: [{ id: '11', Server: { id: '101' } }] } },
  ])('rejects an untrusted user/invitation collection %#', async (invalid) => {
    for (const failedEndpoint of ['users', 'invites']) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          respond(String(url).includes(`/api/${failedEndpoint}`) ? invalid : '<MediaContainer/>'),
        );
      await expect(new Plex('', 'test-client', fetcher).users('synthetic')).rejects.toMatchObject({
        code: 'PLEX_SCHEMA',
      });
    }
  });
  it.each(['<MediaContainer/>', '<MediaContainer size="0"/>', { MediaContainer: { size: 0 } }])(
    'accepts an explicitly empty, valid collection %#',
    async (empty) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => respond(empty));
      expect(await new Plex('', 'test-client', fetcher).users('synthetic')).toEqual([]);
    },
  );
  it('rejects absent library/share envelopes and ambiguous flags', async () => {
    const fixtures = [{}, { MediaContainer: {} }, { MediaContainer: { Server: { size: 1 } } }];
    for (const invalid of fixtures) {
      const plex = new Plex(
        '',
        'test-client',
        vi.fn<typeof fetch>().mockResolvedValue(respond(invalid)),
      );
      await expect(plex.libraries('synthetic')).rejects.toMatchObject({ code: 'PLEX_SCHEMA' });
    }
    for (const detail of [
      {},
      { MediaContainer: {} },
      { MediaContainer: { SharedServer: { Section: { id: '1', shared: 'unknown' } } } },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).includes('shared_servers')) return respond(detail);
        if (String(url).includes('/api/users/'))
          return respond(
            '<MediaContainer><User id="11"><Server id="101" machineIdentifier="synthetic"/></User></MediaContainer>',
          );
        return respond('<MediaContainer/>');
      });
      await expect(new Plex('', 'test-client', fetcher).users('synthetic')).rejects.toMatchObject({
        code: 'PLEX_SCHEMA',
      });
    }
  });
  it('rejects proxy success and mismatched server identities', async () => {
    const server = {
      id: 'synthetic',
      name: 'Sample',
      url: 'http://localhost:32400',
      token: 'synthetic-token',
    };
    for (const data of [
      '<html><body>OK</body></html>',
      { MediaContainer: { machineIdentifier: 'other', version: '1.0' } },
    ])
      await expect(
        new Plex('', 'test-client', vi.fn<typeof fetch>().mockResolvedValue(respond(data))).probe(
          server,
          1000,
        ),
      ).rejects.toThrow();
    await new Plex(
      '',
      'test-client',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          respond('<MediaContainer machineIdentifier="synthetic" version="1.0"/>'),
        ),
    ).probe(server, 1000);
  });
  it('bounds GET retries and never retries uncertain mutations', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => respond('unavailable', 503));
    const plex = new Plex('', 'test-client', fetcher);
    await expect(plex.account()).rejects.toMatchObject({ code: 'PLEX_HTTP' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    await expect(plex.invite('synthetic', 'viewer@example.com', ['1'])).rejects.toMatchObject({
      code: 'PLEX_HTTP',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('handles network timeouts without exposing credentials or body text', async () => {
    const plex = new Plex(
      'synthetic-token',
      'test-client',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret remote diagnostic')),
    );
    await expect(plex.invite('synthetic', 'viewer@example.com', ['1'])).rejects.toThrow(
      'Plex request failed',
    );
  });
  it('uses only the selected server share deletion endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new Plex('', 'test-client', fetcher).revoke('synthetic', {
      id: '11',
      name: 'Sample',
      kind: 'shared',
      shareId: '101',
      libraries: ['1'],
      filters: {},
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://plex.tv/api/v2/shared_servers/101');
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
  });
  it('maps account section IDs rather than PMS keys and parses XML shares', async () => {
    const fixtures = [
      '<MediaContainer><Server><Section id="1" key="10" title="Films &amp; Shows" type="movie"/></Server></MediaContainer>',
      '<MediaContainer><User id="11" title="Sample" restricted="0"><Server id="101" machineIdentifier="synthetic"/></User></MediaContainer>',
      '<MediaContainer/>',
      '<MediaContainer><SharedServer><Section id="1" shared="1"/><Section id="2" shared="0"/></SharedServer></MediaContainer>',
    ];
    const fetcher = vi.fn<typeof fetch>();
    fixtures.forEach((f) => fetcher.mockResolvedValueOnce(respond(f)));
    const plex = new Plex('', 'test-client', fetcher);
    expect((await plex.libraries('synthetic'))[0]).toMatchObject({
      id: '1',
      key: '10',
      title: 'Films & Shows',
    });
    expect((await plex.users('synthetic'))[0]).toMatchObject({
      id: '11',
      shareId: '101',
      libraries: ['1'],
      kind: 'shared',
    });
  });
  it('rejects XML document types and custom entity declarations', async () => {
    const plex = new Plex(
      '',
      'test-client',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          respond(
            '<!DOCTYPE MediaContainer [<!ENTITY sample "synthetic">]><MediaContainer><Server><Section id="1" key="10" title="&sample;" type="movie"/></Server></MediaContainer>',
          ),
        ),
    );
    await expect(plex.libraries('synthetic')).rejects.toMatchObject({ code: 'PLEX_RESPONSE' });
  });
});
