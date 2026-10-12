import { createHmac, randomUUID } from 'node:crypto';
import { equal } from './crypto.js';
import { Store } from './store.js';
import { z } from 'zod';
export const heartbeatPayload = z.object({
  at: z.number().int(),
  nonce: z.uuid(),
  state: z.enum(['healthy', 'unhealthy', 'unknown', 'maintenance']),
});
export type Heartbeat = z.infer<typeof heartbeatPayload>;
export function signature(body: string, key: string) {
  return createHmac('sha256', key).update(body).digest('hex');
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
  const body = JSON.stringify({ at: Date.now(), nonce: randomUUID(), state });
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
    store.set('heartbeat.delivery', { at: Date.now(), ok: response.ok });
  } catch {
    store.set('heartbeat.delivery', { at: Date.now(), ok: false });
  }
}
