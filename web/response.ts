function responseError(response: Response): Error {
  if (response.status === 401 || response.status === 403)
    return new Error(
      `Sign-in is required or access was rejected (HTTP ${response.status}). Reload to sign in and check proxy permissions.`,
    );
  if (response.status >= 500)
    return new Error(
      `Gateway or server error (HTTP ${response.status}). Check the application and reverse proxy, then refresh. Refresh Plex before retrying an access change.`,
    );
  return new Error(
    `The API returned an unexpected response (HTTP ${response.status}). Reload to sign in; if this persists, check reverse proxy routing.`,
  );
}

// A proxy can replace an API error with an HTML page. Never expose its body or
// assume that a redirect, HTML response or malformed JSON confirms a mutation.
export async function readJsonResponse<T>(response: Response): Promise<T> {
  if (response.type === 'opaqueredirect' || response.redirected)
    throw new Error('Sign-in redirected this API request. Reload to sign in, then refresh.');
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!/^application\/(?:json|[\w.-]+\+json)$/i.test(contentType)) throw responseError(response);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw responseError(response);
  }
  if (!response.ok) {
    if (
      data !== null &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string' &&
      data.error.trim()
    )
      throw new Error(data.error);
    throw responseError(response);
  }
  return data as T;
}
