import type { Category, Transaction, TransactionQuery, TransactionSortField } from '@finai/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  listAccounts,
  listCategories,
  listTransactions,
  updateTransaction,
} from '../api/finance.js';
import { useChatController } from '../chat/ChatContext.js';
import { ImportDialog } from '../components/ImportDialog.js';
import { PageHeader } from '../components/Shell.js';
import { CheckIcon, CloseIcon, EditIcon, SparkleIcon } from '../components/icons.js';
import { formatDate, formatMoney } from '../lib/money.js';

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Transaction>();
const EMPTY_ROWS: Transaction[] = [];

const PAGE_SIZES = [25, 50, 100];

/**
 * Rich transaction table. Paging, sorting, searching and filtering all happen
 * on the server — the client holds only the query, which lives in the URL so a
 * filtered view can be linked to (the Accounts page does exactly that).
 */
export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = queryFromParams(searchParams);

  const [searchDraft, setSearchDraft] = useState(query.search ?? '');
  const [isImporting, setImporting] = useState(false);

  // Debounce typing so each keystroke does not hit the API.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((query.search ?? '') !== searchDraft) {
        updateParams({ search: searchDraft, page: '1' });
      }
    }, 300);

    return () => clearTimeout(timer);
    // Intentionally keyed on the draft alone: re-running when the committed
    // query changes would fight the user's typing.
  }, [searchDraft]);

  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories });
  const transactions = useQuery({
    queryKey: ['transactions', query],
    queryFn: () => listTransactions(query),
  });

  const chat = useChatController();
  const queryClient = useQueryClient();
  const recategorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string | null }) =>
      updateTransaction(id, { categoryId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor('postedAt', {
          header: 'Date',
          cell: (context) => <span className="mono">{formatDate(context.getValue())}</span>,
        }),
        helper.accessor('description', {
          header: 'Description',
          cell: (context) => (
            <div className="cell-stack">
              <span>{context.getValue()}</span>
              {context.row.original.notes && (
                <span className="dim cell-note">{context.row.original.notes}</span>
              )}
            </div>
          ),
        }),
        helper.accessor('statementBalanceMinor', {
          header: 'Balance',
          cell: (context) => {
            const balance = context.getValue();
            return (
              <span className="mono dim">
                {balance === null ? '—' : formatMoney(balance, context.row.original.currency)}
              </span>
            );
          },
        }),
        helper.accessor('accountName', {
          header: 'Account',
          cell: (context) => (
            <span className="dim">
              {context.row.original.accountBank} · {context.getValue()}
            </span>
          ),
        }),
        helper.display({
          id: 'category',
          header: 'Category',
          cell: (context) => (
            <CategoryCell
              transaction={context.row.original}
              categories={categories.data ?? []}
              onChange={(categoryId) =>
                recategorize.mutate({ id: context.row.original.id, categoryId })
              }
              onAsk={() => {
                chat.open();
                void chat.proposeRule(context.row.original.id);
              }}
            />
          ),
        }),
        helper.accessor('amountMinor', {
          header: 'Amount',
          cell: (context) => (
            <span
              className={`mono amount ${context.getValue() < 0 ? 'amount--negative' : 'amount--positive'}`}
            >
              {formatMoney(context.getValue(), context.row.original.currency)}
            </span>
          ),
        }),
      ]),
    [categories.data, recategorize, chat],
  );

  const table = useTable({
    features,
    columns,
    data: transactions.data?.items ?? EMPTY_ROWS,
  });

  const page = transactions.data?.page ?? 1;
  const totalPages = transactions.data?.totalPages ?? 1;
  const activeAccount = accounts.data?.find((account) => account.id === query.accountId);

  return (
    <>
      <PageHeader
        title="Transactions"
        description={
          activeAccount
            ? `Filtered to ${activeAccount.bank} — ${activeAccount.name}.`
            : 'Every transaction across all accounts.'
        }
        actions={
          <button
            type="button"
            className="button"
            disabled={(accounts.data ?? []).length === 0}
            onClick={() => setImporting(true)}
          >
            import csv
          </button>
        }
      />

      {isImporting && accounts.data && (
        <ImportDialog
          accounts={accounts.data}
          initialAccountId={query.accountId}
          onClose={() => setImporting(false)}
        />
      )}

      <div className="filters">
        <input
          className="filters__search"
          value={searchDraft}
          placeholder="Search description, notes or account…"
          onChange={(event) => setSearchDraft(event.target.value)}
        />

        <select
          value={query.accountId ?? ''}
          onChange={(event) => updateParams({ accountId: event.target.value, page: '1' })}
        >
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((account) => (
            <option key={account.id} value={account.id}>
              {account.bank} — {account.name}
            </option>
          ))}
        </select>

        <select
          value={query.uncategorized ? 'uncategorized' : (query.categoryId ?? '')}
          onChange={(event) => {
            const value = event.target.value;
            updateParams({
              categoryId: value === 'uncategorized' ? null : value,
              uncategorized: value === 'uncategorized' ? 'true' : null,
              page: '1',
            });
          }}
        >
          <option value="">All categories</option>
          <option value="uncategorized">Uncategorized</option>
          {(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        <label className="field field--inline">
          <span className="label">from</span>
          <input
            type="date"
            value={query.from ?? ''}
            onChange={(event) => updateParams({ from: event.target.value, page: '1' })}
          />
        </label>

        <label className="field field--inline">
          <span className="label">to</span>
          <input
            type="date"
            value={query.to ?? ''}
            onChange={(event) => updateParams({ to: event.target.value, page: '1' })}
          />
        </label>

        {searchParams.toString() !== '' && (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setSearchDraft('');
              setSearchParams(new URLSearchParams(), { replace: true });
            }}
          >
            clear
          </button>
        )}
      </div>

      {transactions.isError && <p className="error">{transactions.error.message}</p>}
      {recategorize.isError && <p className="error">{recategorize.error.message}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sortField = toSortField(header.column.id);
                  const isSorted = sortField && (query.sort ?? 'postedAt') === sortField;

                  return (
                    <th key={header.id} className={sortField ? 'th--sortable' : undefined}>
                      {sortField ? (
                        <button
                          type="button"
                          className="th__button"
                          onClick={() =>
                            updateParams({
                              sort: sortField,
                              direction: isSorted && query.direction === 'asc' ? 'desc' : 'asc',
                              page: '1',
                            })
                          }
                        >
                          <table.FlexRender header={header} />
                          {isSorted && (
                            <span aria-hidden>{query.direction === 'asc' ? '↑' : '↓'}</span>
                          )}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={row.original.kind === 'adjustment' ? 'row--adjustment' : undefined}
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}

            {transactions.data?.items.length === 0 && (
              <tr>
                <td colSpan={6} className="dim table__empty">
                  {transactions.isPending ? 'Loading…' : 'No transactions match this view.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <div className="table-footer__totals mono">
          <span className="amount--positive">
            in {formatMoney(transactions.data?.totals.inMinor ?? 0, 'GBP')}
          </span>
          <span className="amount--negative">
            out {formatMoney(transactions.data?.totals.outMinor ?? 0, 'GBP')}
          </span>
          <span>net {formatMoney(transactions.data?.totals.netMinor ?? 0, 'GBP')}</span>
        </div>

        <div className="pager">
          <span className="label">
            {transactions.data?.total ?? 0} rows · page {page} of {totalPages}
          </span>

          <select
            value={query.pageSize ?? 25}
            onChange={(event) => updateParams({ pageSize: event.target.value, page: '1' })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>

          <button
            type="button"
            className="button button--ghost"
            disabled={page <= 1}
            onClick={() => updateParams({ page: String(page - 1) })}
          >
            prev
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={page >= totalPages}
            onClick={() => updateParams({ page: String(page + 1) })}
          >
            next
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Category shows as plain text until you act on it: the pen swaps in a picker
 * with confirm and cancel, the sparkle hands the transaction to the assistant
 * to propose a rule for everything like it.
 */
function CategoryCell({
  transaction,
  categories,
  onChange,
  onAsk,
}: {
  transaction: Transaction;
  categories: Category[];
  onChange: (categoryId: string | null) => void;
  onAsk: () => void;
}) {
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState(transaction.categoryId ?? '');

  if (isEditing) {
    return (
      <div className="category-cell">
        <select
          className="cell-select"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        >
          <option value="">uncategorized</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="icon-button icon-button--confirm"
          aria-label="Save category"
          onClick={() => {
            if (draft !== (transaction.categoryId ?? '')) onChange(draft === '' ? null : draft);
            setEditing(false);
          }}
        >
          <CheckIcon size={14} />
        </button>

        <button
          type="button"
          className="icon-button"
          aria-label="Cancel"
          onClick={() => {
            setDraft(transaction.categoryId ?? '');
            setEditing(false);
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="category-cell">
      <span
        className={transaction.categoryName ? 'category-chip' : 'dim'}
        style={
          transaction.categoryColor
            ? { borderColor: transaction.categoryColor, color: transaction.categoryColor }
            : undefined
        }
      >
        {transaction.categoryName ?? 'uncategorized'}
      </span>

      <button
        type="button"
        className="icon-button"
        aria-label="Change category"
        onClick={() => setEditing(true)}
      >
        <EditIcon size={14} />
      </button>

      <button
        type="button"
        className="icon-button icon-button--accent"
        aria-label="Ask the assistant for a rule"
        title="Ask the assistant to suggest a rule for transactions like this"
        onClick={onAsk}
      >
        <SparkleIcon size={14} />
      </button>
    </div>
  );
}

function queryFromParams(params: URLSearchParams): TransactionQuery {
  const query: TransactionQuery = {
    page: Number(params.get('page') ?? '1'),
    pageSize: Number(params.get('pageSize') ?? '25'),
  };

  const search = params.get('search');
  if (search) query.search = search;

  const accountId = params.get('accountId');
  if (accountId) query.accountId = accountId;

  const categoryId = params.get('categoryId');
  if (categoryId) query.categoryId = categoryId;

  if (params.get('uncategorized') === 'true') query.uncategorized = true;

  const from = params.get('from');
  if (from) query.from = from;

  const to = params.get('to');
  if (to) query.to = to;

  const sort = toSortField(params.get('sort') ?? '');
  if (sort) query.sort = sort;

  const direction = params.get('direction');
  if (direction === 'asc' || direction === 'desc') query.direction = direction;

  return query;
}

function toSortField(value: string): TransactionSortField | null {
  return value === 'postedAt' || value === 'amountMinor' || value === 'description' ? value : null;
}
