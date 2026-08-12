import type {
  Account,
  AccountInput,
  AuditEvent,
  AuditQuery,
  Automation,
  AutomationInput,
  Category,
  CategoryInput,
  Page,
  Transaction,
  TransactionInput,
  TransactionPage,
  TransactionQuery,
} from '@finai/shared';

import { apiFetch } from './client.js';

/* ---------- accounts ---------- */

export const listAccounts = (): Promise<Account[]> => apiFetch<Account[]>('/accounts');

export const createAccount = (input: AccountInput): Promise<Account> =>
  apiFetch<Account>('/accounts', { method: 'POST', body: JSON.stringify(input) });

export const updateAccount = (id: string, input: Partial<AccountInput>): Promise<Account> =>
  apiFetch<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteAccount = (id: string): Promise<void> =>
  apiFetch<void>(`/accounts/${id}`, { method: 'DELETE' });

/* ---------- categories ---------- */

export const listCategories = (): Promise<Category[]> => apiFetch<Category[]>('/categories');

export const createCategory = (input: CategoryInput): Promise<Category> =>
  apiFetch<Category>('/categories', { method: 'POST', body: JSON.stringify(input) });

export const updateCategory = (id: string, input: Partial<CategoryInput>): Promise<Category> =>
  apiFetch<Category>(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteCategory = (id: string): Promise<void> =>
  apiFetch<void>(`/categories/${id}`, { method: 'DELETE' });

/* ---------- transactions ---------- */

export function listTransactions(query: TransactionQuery): Promise<TransactionPage> {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }

  const search = params.toString();
  return apiFetch<TransactionPage>(`/transactions${search ? `?${search}` : ''}`);
}

export const createTransaction = (input: TransactionInput): Promise<Transaction> =>
  apiFetch<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(input) });

export const updateTransaction = (
  id: string,
  input: Partial<Omit<TransactionInput, 'accountId'>>,
): Promise<Transaction> =>
  apiFetch<Transaction>(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteTransaction = (id: string): Promise<void> =>
  apiFetch<void>(`/transactions/${id}`, { method: 'DELETE' });

/* ---------- automations ---------- */

export const listAutomations = (): Promise<Automation[]> => apiFetch<Automation[]>('/automations');

export const createAutomation = (input: AutomationInput): Promise<Automation> =>
  apiFetch<Automation>('/automations', { method: 'POST', body: JSON.stringify(input) });

export const updateAutomation = (
  id: string,
  input: Partial<AutomationInput>,
): Promise<Automation> =>
  apiFetch<Automation>(`/automations/${id}`, { method: 'PATCH', body: JSON.stringify(input) });

export const deleteAutomation = (id: string): Promise<void> =>
  apiFetch<void>(`/automations/${id}`, { method: 'DELETE' });

/* ---------- audit ---------- */

export function listAudit(query: AuditQuery): Promise<Page<AuditEvent>> {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.actors?.length) params.set('actors', query.actors.join(','));
  if (query.entity) params.set('entity', query.entity);
  if (query.entityId) params.set('entityId', query.entityId);

  const search = params.toString();
  return apiFetch<Page<AuditEvent>>(`/audit${search ? `?${search}` : ''}`);
}
