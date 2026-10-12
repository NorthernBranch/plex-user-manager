import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.js';
import { defaultMonitor, type MonitorSettings, type SmtpSettings } from '../server/config.js';
import type { PlexAdapter, PlexUser, Restrictions } from '../server/plex.js';
export function memory() {
  return new Store(':memory:', randomBytes(32).toString('hex'));
}
export function monitorSettings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
  return {
    ...defaultMonitor,
    intervalSeconds: 5,
    timeoutSeconds: 1,
    failureSeconds: 15,
    recoveryCount: 2,
    recipients: [
      { email: 'one@example.com', outage: true, recovery: true },
      { email: 'two@example.com', outage: true, recovery: true },
    ],
    ...overrides,
  };
}
export const testSmtp: SmtpSettings = {
  host: 'localhost',
  port: 465,
  tls: 'implicit',
  username: '',
  password: '',
  from: 'alerts@example.com',
};
export class MockPlex implements PlexAdapter {
  shares: Record<string, PlexUser[]> = {
    synthetic: [
      {
        id: '11',
        name: 'Sample viewer',
        kind: 'shared',
        shareId: '101',
        libraries: ['1'],
        filters: {},
      },
    ],
    other: [
      {
        id: '11',
        name: 'Sample viewer',
        kind: 'shared',
        shareId: '202',
        libraries: ['2'],
        filters: {},
      },
    ],
  };
  failUser = '';
  pass = true;
  calls: { server: string; share: string; action: string }[] = [];
  async ownedServers() {
    return [
      {
        id: 'synthetic',
        name: 'Sample server',
        connections: ['http://localhost:32400'],
        token: 'synthetic-test-token',
      },
    ];
  }
  async account() {
    return { plexPass: this.pass };
  }
  async libraries(_server: string) {
    return [
      { id: '1', key: '10', title: 'Sample Films', type: 'movie' },
      { id: '2', key: '20', title: 'Sample Shows', type: 'show' },
    ];
  }
  async users(server: string) {
    return structuredClone(this.shares[server] ?? []);
  }
  async invite(server: string, identity: string, libraries: string[]) {
    this.shares[server].push({
      id: '99',
      name: identity,
      kind: 'pending',
      shareId: '909',
      libraries,
      filters: {},
    });
  }
  async update(server: string, user: PlexUser, libraries: string[]) {
    if (user.id === this.failUser) throw new Error('Synthetic failure');
    const found = this.shares[server].find((u) => u.id === user.id)!;
    found.libraries = [...libraries];
    this.calls.push({ server, share: user.shareId, action: 'update' });
  }
  async revoke(server: string, user: PlexUser) {
    this.shares[server] = this.shares[server].filter((u) => u.shareId !== user.shareId);
    this.calls.push({ server, share: user.shareId, action: 'revoke' });
  }
  async restrictions(_user: string, _values: Restrictions) {}
  async probe() {}
}
