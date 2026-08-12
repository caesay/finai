import type { ApiErrorResponse } from '@finai/shared';

/** Fastify's own error envelope, which differs from our handled-error shape. */
interface FastifyErrorResponse {
  message?: string;
}

/**
 * Thin fetch wrapper. Same-origin in production; Vite proxies /api in dev.
 *
 * The JSON content type is only set when there is a body to describe: Fastify
 * rejects a request that declares application/json but sends nothing.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`/api${path}`, { ...init, headers });

  if (!response.ok) {
    throw new Error(await describeError(response));
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

async function describeError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    (ApiErrorResponse & FastifyErrorResponse) | null;

  return (
    body?.error?.message ?? body?.message ?? `Request failed with status ${String(response.status)}`
  );
}
