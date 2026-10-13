import { test, expect, type Page } from '@playwright/test';
import type { Restrictions } from '../../server/plex.js';
import { defaultCommunications } from '../../server/communications-config.js';
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
      '/api/communications': {
        settings: defaultCommunications,
        contacts: [],
        campaigns: [],
        jobs: [],
        memberships: [],
        external: null,
        maintenanceExport: {
          maintenance: [],
          digest: 'synthetic-digest',
          instructions: 'Provision the external worker before an outage.',
        },
      },
      '/api/communications/history': [],
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

test('Users explains an HTML gateway error without displaying its body', async ({ page }) => {
  await page.route('**/api/users', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<!DOCTYPE html><title>Synthetic gateway error</title><p>Private diagnostic</p>',
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Gateway or server error (HTTP 502)');
  await expect(page.getByText('Private diagnostic')).not.toBeVisible();
});

test('Users does not follow an API sign-in redirect', async ({ page }) => {
  let signInRequests = 0;
  await page.route('**/synthetic-sign-in', (route) => {
    signInRequests++;
    return route.fulfill({
      contentType: 'text/html',
      body: '<!DOCTYPE html><title>Sign in</title>',
    });
  });
  await page.route('**/api/users', (route) =>
    route.fulfill({ status: 302, headers: { Location: '/synthetic-sign-in' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Sign-in redirected');
  expect(signInRequests).toBe(0);
});
test('communications navigation, UTC draft fields and offline controls', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Communications', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Communications', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New announcement' }).click();
  await page.getByLabel('Message subject', { exact: true }).fill('Synthetic announcement');
  await page.getByLabel('Plain-text message body', { exact: true }).fill('Synthetic message.');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Preview recipients & content' }),
  ).not.toBeVisible();
});
test('recipient fragment is removed, GET is harmless and verification requires confirmation', async ({
  page,
  context,
}) => {
  const token = 'a'.repeat(64);
  let verified = 0;
  await page.route('**/api/recipient/**', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().url()).not.toContain(token);
    expect(route.request().postDataJSON().token).toBe(token);
    if (route.request().url().endsWith('/verify')) verified++;
    await route.fulfill({
      json: {
        email: 'viewer@example.com',
        verified: false,
        unsubscribed: false,
        preferences: {
          outage: false,
          recovery: false,
          announcement: false,
          maintenance: false,
          welcome: false,
          expiry: false,
        },
        scope: 'verify',
        expires: Date.now() + 86400000,
      },
    });
  });
  await page.goto(`/recipient#token=${token}`);
  await expect(page.getByText('Address: viewer@example.com')).toBeVisible();
  expect(page.url()).not.toContain(token);
  expect(verified).toBe(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Confirm address verification' }).click();
  await expect(page.getByRole('status')).toContainText('Consent is unchanged');
  expect(verified).toBe(1);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Confirm address verification' })).toBeDisabled();
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

async function openRestrictionEditor(page: Page, filters: Record<string, string>) {
  await page.route('**/api/users', (route) =>
    route.fulfill({
      json: {
        server: 'synthetic',
        libraries: [{ id: '1', title: 'Sample Films', type: 'movie' }],
        users: [
          {
            id: '11',
            name: 'Sample viewer',
            kind: 'shared',
            shareId: '101',
            libraries: ['1'],
            notes: '',
            expiry: null,
            filters,
          },
        ],
        capabilities: {
          plexPass: true,
          restrictionScope: 'Account sharing settings across servers.',
        },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Sample viewer', exact: true }).click();
}
test('restrictions prefill, preview intentional clearing and retain unchanged fields', async ({
  page,
}) => {
  const filters = {
    filterMovies: 'contentRating=G%2CPG|label=Family%20films',
    filterTelevision: 'contentRating=TV-PG|label=Sample%20shows',
    filterMusic: 'label=Sample%20music',
  };
  let mutation: { expectedFilters: Record<string, string>; values: Restrictions } | undefined;
  await page.route('**/api/users/11/restrictions', async (route) => {
    mutation = route.request().postDataJSON();
    await route.fulfill({ json: { message: 'Synthetic restrictions confirmed.' } });
  });
  await openRestrictionEditor(page, filters);
  await expect(page.getByLabel('Movie content ratings', { exact: true })).toHaveValue('G, PG');
  await expect(page.getByLabel('Allowed movie labels')).toHaveValue('Family films');
  await expect(page.getByLabel('TV content ratings', { exact: true })).toHaveValue('TV-PG');
  await expect(page.getByLabel('Allowed TV labels')).toHaveValue('Sample shows');
  await expect(page.getByLabel('Allowed music labels')).toHaveValue('Sample music');
  await page.getByLabel('Movie content ratings', { exact: true }).fill('G');
  await page.getByLabel('Allowed music labels').fill('');
  await page.getByRole('button', { name: 'Review & replace restrictions' }).click();
  const preview = page.getByRole('region', { name: 'Restriction change preview' });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('row', { name: /Allowed music labels/ })).toContainText(
    'No restriction (cleared)',
  );
  await expect(preview.getByRole('row', { name: /Allowed TV labels/ })).toContainText(
    'Sample shows (unchanged)',
  );
  expect(mutation).toBeUndefined();
  await page.getByLabel('TV content ratings', { exact: true }).fill('TV-G');
  await expect(preview).not.toBeVisible();
  await page.getByLabel('TV content ratings', { exact: true }).fill('TV-PG');
  await page.getByRole('button', { name: 'Review & replace restrictions' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Apply reviewed restrictions' }).click();
  expect(mutation).toBeUndefined();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Apply reviewed restrictions' }).click();
  await expect.poll(() => mutation).toBeDefined();
  expect(mutation).toMatchObject({
    expectedFilters: filters,
    values: {
      movies: { ratings: ['G'], labels: ['Family films'] },
      television: { ratings: ['TV-PG'], labels: ['Sample shows'] },
      music: { labels: [] },
    },
  });
});
test('unsupported existing restriction syntax cannot be replaced with blank inputs', async ({
  page,
}) => {
  await openRestrictionEditor(page, { filterMovies: 'contentRating!=PG' });
  await expect(page.getByRole('alert')).toContainText('Use Plex Web');
  await expect(page.getByRole('button', { name: 'Review & replace restrictions' })).toBeDisabled();
});
