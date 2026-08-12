import type { ApiErrorResponse } from '@finai/shared';

/**
 * Thin fetch wrapper. Same-origin in production; Vite proxies /api in dev.
 * Credentials are included so cookie-based sessions work once auth lands.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(body?.error?.message ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}
