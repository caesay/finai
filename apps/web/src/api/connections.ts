import type {
  Connection,
  ConnectionAccount,
  ConnectionInput,
  ConnectionLinkPlan,
  ConnectionReview,
  ConnectionSettings,
  ConnectionSyncResult,
} from '@finai/shared';

import { apiFetch } from './client.js';

export const listConnections = (): Promise<Connection[]> => apiFetch<Connection[]>('/connections');

export const getConnection = (id: string): Promise<Connection> =>
  apiFetch<Connection>(`/connections/${id}`);

export const createConnection = (input: ConnectionInput): Promise<Connection> =>
  apiFetch<Connection>('/connections', { method: 'POST', body: JSON.stringify(input) });

export const updateConnection = (
  id: string,
  input: { name?: string; apiKey?: string; settings?: Partial<ConnectionSettings> },
): Promise<Connection> =>
  apiFetch<Connection>(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteConnection = (id: string): Promise<void> =>
  apiFetch<void>(`/connections/${id}`, { method: 'DELETE' });

export const listConnectionAccounts = (id: string): Promise<ConnectionAccount[]> =>
  apiFetch<ConnectionAccount[]>(`/connections/${id}/accounts`);

/** Costs a Codex turn, so it is only asked for when the review screen opens. */
export const reviewConnection = (id: string): Promise<ConnectionReview> =>
  apiFetch<ConnectionReview>(`/connections/${id}/review`, { method: 'POST' });

export const saveConnectionLinks = (
  id: string,
  links: ConnectionLinkPlan[],
): Promise<ConnectionAccount[]> =>
  apiFetch<ConnectionAccount[]>(`/connections/${id}/links`, {
    method: 'POST',
    body: JSON.stringify({ links }),
  });

export const syncConnection = (id: string): Promise<ConnectionSyncResult> =>
  apiFetch<ConnectionSyncResult>(`/connections/${id}/sync`, { method: 'POST' });
