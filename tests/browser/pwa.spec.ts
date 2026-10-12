import { test, expect } from '@playwright/test';
const monitor = {
  enabled: true,
  intervalSeconds: 30,
  timeoutSeconds: 10,
  failureSeconds: 300,
  recoveryCount: 2,
  recipients: [{ email: 'viewer@example.com', outage: true, recovery: true }],
  maintenance: [],
  outageSubject: 'Plex outage',
  outageBody: 'Incident {{incident}}',
  recoverySubject: 'Plex recovered',
  recoveryBody: 'Observed downtime {{downtime}}',
  authority: 'local',
};
const settings = {
  publicUrl: 'https://plex-admin.example.com',
  plexConnected: true,
  server: { id: 'synthetic', name: 'Sample Plex Server', url: 'http://localhost:32400' },
  monitor,
  smtp: null,
  heartbeat: null,
  heartbeatDelivery: null,
};
const health = {
  state: { state: 'healthy', unknown: false, lastOk: true, last: 1780000000000 },
  incidents: [],
  timeline: [
    { at: 1780000000000, event: 'Plex identity confirmed.' },
    { at: 1779999940000, event: 'Monitoring restarted: unobserved time is unknown.' },
  ],
  expiries: [],
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/setup/status': { initialized: true },
      '/api/session': { csrf: 'synthetic-csrf' },
      '/api/settings': settings,
      '/api/monitor': health,
      '/api/audit': [],
      '/api/presets': [],
      '/api/deliveries': [],
      '/api/users': {
        server: 'synthetic',
        libraries: [
          { id: '1', title: 'Sample Films', type: 'movie' },
          { id: '2', title: 'Sample Shows', type: 'show' },
        ],
        users: [
          {
            id: '11',
            name: 'Sample viewer',
            kind: 'shared',
            shareId: '101',
            libraries: ['1'],
            notes: 'Synthetic administrator note',
            filters: { filterMovies: '' },
            expiry: null,
          },
          {
            id: '12',
            name: 'Pending viewer',
            kind: 'pending',
            shareId: '102',
            libraries: ['2'],
            notes: '',
            filters: {},
            expiry: null,
          },
        ],
        capabilities: {
          plexPass: false,
          restrictionScope: 'Account sharing settings across servers.',
        },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] ?? { ok: true }),
    });
  });
});
test('responsive dashboard, accessible editor and synthetic screenshot', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your Plex, under control.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `docs/screenshot-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Sample viewer', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Private administrator notes').fill('Synthetic replacement note');
  await expect(page.getByRole('button', { name: 'Review & replace restrictions' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('offline state disables access mutations without replay', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sample viewer', exact: true })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('You are offline', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
  await page.getByRole('button', { name: 'Sample viewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save library access' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Revoke server access' })).toBeDisabled();
});
test('public service worker cache never contains authenticated responses', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        result.push(new URL(request.url).pathname);
    return result;
  });
  expect(cached.some((url) => url.startsWith('/api'))).toBe(false);
  expect(cached).toContain('/offline.html');
});
