import { readJsonResponse } from './response.js';

let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  if (method !== 'GET' && !navigator.onLine)
    throw new Error('You are offline. Changes are disabled and will not be replayed.');
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readJsonResponse<T>(response);
}
