import { createHmac, randomUUID } from 'node:crypto';
import { equal } from './crypto.js';
import { Store } from './store.js';
import { z } from 'zod';
import { effectiveMonitorSettings, maintenanceDigest } from './maintenance.js';
import { notificationRecipients } from './recipients.js';
import { hash } from './crypto.js';
export const heartbeatPayload = z.object({
  at: z.number().int(),
  nonce: z.uuid(),
  state: z.enum(['healthy', 'unhealthy', 'unknown', 'maintenance']),
});
export type Heartbeat = z.infer<typeof heartbeatPayload>;
export function signature(body: string, key: string) {
  return createHmac('sha256', key).update(body).digest('hex');
}
export function configurationDigests(store: Store) {
  const settings = effectiveMonitorSettings(store),
    server = store.getSecret<{ id: string }>('server');
  return {
    maintenance: maintenanceDigest(settings.maintenance),
    recipients: hash(
      JSON.stringify(
        notificationRecipients(store, settings, server?.id).sort((a, b) =>
          a.email.localeCompare(b.email),
        ),
      ),
    ),
  };
}
export function heartbeatAcknowledgement(store: Store, nonce: string, key: string) {
  const digests = configurationDigests(store);
  return {
    'X-Worker-Maintenance-Digest': digests.maintenance,
    'X-Worker-Recipient-Digest': digests.recipients,
    'X-Heartbeat-Ack-Signature': signature(
      `${nonce}|${digests.maintenance}|${digests.recipients}`,
      key,
    ),
  };
}
export function acceptHeartbeat(
  store: Store,
  body: string,
  sig: string,
  key: string,
  now = Date.now(),
) {
  if (!equal(signature(body, key), sig)) return false;
  const parsed = heartbeatPayload.safeParse(JSON.parse(body));
  if (!parsed.success || Math.abs(now - parsed.data.at) > 60000) return false;
  const previous = store.get<Heartbeat>('heartbeat.received');
  if (previous && (previous.at >= parsed.data.at || previous.nonce === parsed.data.nonce))
    return false;
  store.set('heartbeat.received', parsed.data);
  return true;
}
export async function sendHeartbeat(
  store: Store,
  state: Heartbeat['state'],
  fetcher: typeof fetch = fetch,
) {
  const config = store.getSecret<{ url: string; key: string }>('heartbeat');
  if (!config) return;
  const nonce = randomUUID();
  const body = JSON.stringify({ at: Date.now(), nonce, state });
  try {
    const response = await fetcher(config.url, {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        'X-Heartbeat-Signature': signature(body, config.key),
      },
    });
    const maintenance = response.headers.get('X-Worker-Maintenance-Digest'),
      recipients = response.headers.get('X-Worker-Recipient-Digest'),
      ack = response.headers.get('X-Heartbeat-Ack-Signature');
    const authenticated =
      !!maintenance &&
      !!recipients &&
      !!ack &&
      equal(signature(`${nonce}|${maintenance}|${recipients}`, config.key), ack);
    const expected = configurationDigests(store);
    store.set('heartbeat.delivery', {
      at: Date.now(),
      ok: response.ok,
      configurationAuthenticated: authenticated,
      workerMaintenanceDigest: authenticated ? maintenance : null,
      workerRecipientDigest: authenticated ? recipients : null,
      maintenanceMatch: authenticated ? maintenance === expected.maintenance : null,
      recipientsMatch: authenticated ? recipients === expected.recipients : null,
    });
  } catch {
    store.set('heartbeat.delivery', { at: Date.now(), ok: false });
  }
}
