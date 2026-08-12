import type {
  Account,
  CsvDateFormat,
  CsvMapping,
  CsvPreview,
  CsvReconciliation,
} from '@finai/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { analyzeCsv, commitCsv, previewCsv } from '../api/imports.js';
import { formatDate, formatMoney } from '../lib/money.js';
import { LoadingLine, Spinner } from './Spinner.js';

interface ImportDialogProps {
  accounts: Account[];
  initialAccountId?: string;
  onClose: () => void;
}

/**
 * CSV import in three steps: drop a file, check the mapping the assistant
 * proposed, import.
 *
 * The assistant only ever names columns. Every row shown in the preview — and
 * every row that ends up imported — is produced by the mechanical transform on
 * the server from the mapping below, so what you see previewed is exactly what
 * gets written.
 */
export function ImportDialog({ accounts, initialAccountId, onClose }: ImportDialogProps) {
  const queryClient = useQueryClient();

  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [reason, setReason] = useState('');
  const [confidence, setConfidence] = useState<'high' | 'medium' | 'low'>('low');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  // Only preselect when the choice is unambiguous: the page was already
  // filtered to an account, or there is only one. Otherwise the destination has
  // to be picked deliberately — importing a statement into the wrong account is
  // tedious to undo.
  const [accountId, setAccountId] = useState(
    initialAccountId ?? (accounts.length === 1 ? (accounts[0]?.id ?? '') : ''),
  );
  const [isDragging, setDragging] = useState(false);
  const [anchorOpeningBalance, setAnchorOpeningBalance] = useState(true);

  const analyze = useMutation({
    mutationFn: analyzeCsv,
    onSuccess: (analysis) => {
      setHeaders(analysis.headers);
      setTotalRows(analysis.totalRows);
      setMapping(analysis.suggestion.mapping);
      setReason(analysis.suggestion.reason);
      setConfidence(analysis.suggestion.confidence);
      setPreview(analysis.preview);
    },
  });

  const refreshPreview = useMutation({
    mutationFn: (next: CsvMapping) => previewCsv(csv, next),
    onSuccess: setPreview,
  });

  const commit = useMutation({
    mutationFn: () =>
      commitCsv(csv, mapping as CsvMapping, accountId, {
        setOpeningBalance: anchorOpeningBalance && preview?.reconciliation.available === true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function acceptFile(file: File | undefined) {
    if (!file) return;

    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    setPreview(null);
    setMapping(null);
    analyze.mutate(text);
  }

  function changeMapping(changes: Partial<CsvMapping>) {
    if (!mapping) return;

    const next = { ...mapping, ...changes };
    setMapping(next);
    refreshPreview.mutate(next);
  }

  const currency = accounts.find((account) => account.id === accountId)?.currency ?? 'GBP';
  const canImport = Boolean(mapping && accountId && (preview?.validRows ?? 0) > 0);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Import transactions">
      <div className="modal__panel">
        <header className="modal__head">
          <span className="label">import transactions from csv</span>
          <button type="button" className="button button--ghost" onClick={onClose}>
            close
          </button>
        </header>

        <div className="modal__body">
          {commit.isSuccess ? (
            <div className="import-done">
              <p>
                Imported <strong>{commit.data.imported}</strong> transactions
                {commit.data.skipped > 0 && `, skipped ${commit.data.skipped} already seen`}.
              </p>
              {commit.data.adjustments > 0 && (
                <p className="error">
                  {commit.data.adjustments} balance adjustments were added where the statement did
                  not add up.
                </p>
              )}
              {commit.data.openingBalanceMinor !== null && (
                <p className="dim">
                  Opening balance set to {formatMoney(commit.data.openingBalanceMinor, currency)}.
                </p>
              )}
              {commit.data.errors.length > 0 && (
                <p className="dim">{commit.data.errors.length} rows could not be read.</p>
              )}
              <button type="button" className="button" onClick={onClose}>
                done
              </button>
            </div>
          ) : (
            <>
              <label className="field">
                <span className="label">import into</span>
                <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  <option value="">choose an account…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.bank} — {account.name}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void acceptFile(event.dataTransfer.files[0]);
                }}
              >
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="dropzone__input"
                  onChange={(event) => void acceptFile(event.target.files?.[0])}
                />
                <span>{fileName || 'Drop a CSV here, or click to choose one'}</span>
                {totalRows > 0 && <span className="label">{totalRows} rows</span>}
              </label>

              {analyze.isPending && (
                <LoadingLine>Reading the file and working out the columns…</LoadingLine>
              )}
              {analyze.isError && <p className="error">{analyze.error.message}</p>}

              {mapping && (
                <>
                  <div className="import-note">
                    <span className={`chip chip--${confidence === 'high' ? 'ai' : 'off'}`}>
                      {confidence} confidence
                    </span>
                    <span className="dim">{reason}</span>
                  </div>

                  <div className="form__row">
                    <MappingSelect
                      label="date"
                      headers={headers}
                      value={mapping.dateColumn}
                      onChange={(dateColumn) => changeMapping({ dateColumn })}
                    />

                    <label className="field field--narrow">
                      <span className="label">date format</span>
                      <select
                        value={mapping.dateFormat}
                        onChange={(event) =>
                          changeMapping({ dateFormat: event.target.value as CsvDateFormat })
                        }
                      >
                        <option value="iso">2026-08-01</option>
                        <option value="dmy">01/08/2026</option>
                        <option value="mdy">08/01/2026</option>
                      </select>
                    </label>

                    <MappingSelect
                      label="description"
                      headers={headers}
                      value={mapping.descriptionColumn}
                      onChange={(descriptionColumn) => changeMapping({ descriptionColumn })}
                    />
                  </div>

                  <div className="form__row">
                    <label className="field field--narrow">
                      <span className="label">amount columns</span>
                      <select
                        value={mapping.amountMode}
                        onChange={(event) =>
                          changeMapping({
                            amountMode: event.target.value as CsvMapping['amountMode'],
                          })
                        }
                      >
                        <option value="single">one signed column</option>
                        <option value="debit_credit">separate in / out</option>
                      </select>
                    </label>

                    {mapping.amountMode === 'single' ? (
                      <MappingSelect
                        label="amount"
                        headers={headers}
                        value={mapping.amountColumn}
                        onChange={(amountColumn) => changeMapping({ amountColumn })}
                      />
                    ) : (
                      <>
                        <MappingSelect
                          label="money out"
                          headers={headers}
                          value={mapping.debitColumn}
                          onChange={(debitColumn) => changeMapping({ debitColumn })}
                        />
                        <MappingSelect
                          label="money in"
                          headers={headers}
                          value={mapping.creditColumn}
                          onChange={(creditColumn) => changeMapping({ creditColumn })}
                        />
                      </>
                    )}

                    {/* Separate in/out columns already carry the direction. */}
                    {mapping.amountMode === 'single' && (
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={mapping.invertAmount}
                          onChange={(event) =>
                            changeMapping({ invertAmount: event.target.checked })
                          }
                        />
                        <span className="label">flip sign</span>
                      </label>
                    )}
                  </div>

                  <div className="form__row">
                    <MappingSelect
                      label="notes (optional)"
                      headers={headers}
                      value={mapping.notesColumn}
                      onChange={(notesColumn) => changeMapping({ notesColumn })}
                      allowNone
                    />
                    <MappingSelect
                      label="unique reference (optional)"
                      headers={headers}
                      value={mapping.externalIdColumn}
                      onChange={(externalIdColumn) => changeMapping({ externalIdColumn })}
                      allowNone
                    />
                  </div>

                  {preview?.reconciliation.available && (
                    <Reconciliation
                      reconciliation={preview.reconciliation}
                      currency={currency}
                      anchor={anchorOpeningBalance}
                      onAnchorChange={setAnchorOpeningBalance}
                    />
                  )}

                  {/* Editing a column re-runs the transform on the server, and
                      the table below is the old mapping's output until it
                      lands. */}
                  {refreshPreview.isPending && (
                    <LoadingLine>Re-reading the file with this mapping…</LoadingLine>
                  )}

                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Description</th>
                          <th>Notes</th>
                          <th>Balance</th>
                          <th>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview?.rows.map((row, position) => (
                          <tr
                            key={`${String(row.row)}-${String(position)}`}
                            className={row.kind === 'adjustment' ? 'row--adjustment' : undefined}
                          >
                            <td className="mono nowrap">{formatDate(row.postedAt)}</td>
                            <td>{row.description}</td>
                            <td className="dim">{row.notes ?? '—'}</td>
                            <td className="mono dim">
                              {row.balanceMinor === null
                                ? '—'
                                : formatMoney(row.balanceMinor, currency)}
                            </td>
                            <td
                              className={`mono ${row.amountMinor < 0 ? 'amount--negative' : 'amount--positive'}`}
                            >
                              {formatMoney(row.amountMinor, currency)}
                            </td>
                          </tr>
                        ))}

                        {preview?.rows.length === 0 && (
                          <tr>
                            <td colSpan={5} className="dim table__empty">
                              No row converted with this mapping.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {preview && preview.errors.length > 0 && (
                    <p className="dim">
                      {preview.errors.length} of {totalRows} rows will be skipped — first problem:{' '}
                      {preview.errors[0]?.message}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {!commit.isSuccess && (
          <footer className="modal__foot">
            <span className="label">
              {!accountId
                ? 'choose an account first'
                : preview
                  ? `${preview.validRows} of ${totalRows} rows ready`
                  : ''}
            </span>

            <div className="modal__actions">
              {commit.isError && <span className="error">{commit.error.message}</span>}
              <button type="button" className="button button--ghost" onClick={onClose}>
                cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!canImport || commit.isPending}
                onClick={() => commit.mutate()}
              >
                {commit.isPending && <Spinner label="Importing transactions" />}
                {commit.isPending ? 'importing' : `import ${preview?.validRows ?? 0} rows`}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * What the statement's own balance column says about the mapping. A clean
 * reconciliation is strong evidence the columns and signs are right; gaps are
 * imported as visible adjustments rather than silently absorbed.
 */
function Reconciliation({
  reconciliation,
  currency,
  anchor,
  onAnchorChange,
}: {
  reconciliation: CsvReconciliation;
  currency: string;
  anchor: boolean;
  onAnchorChange: (value: boolean) => void;
}) {
  const clean = reconciliation.mismatches === 0;

  return (
    <div className="reconcile">
      <div className="reconcile__line">
        <span className={`status__dot ${clean ? 'status__dot--ok' : 'status__dot--error'}`} />
        <span>
          {clean
            ? `Balances agree across all ${reconciliation.checked} rows.`
            : `${reconciliation.mismatches} of ${reconciliation.checked} rows do not match the statement balance — each becomes a balance adjustment.`}
        </span>
      </div>

      {reconciliation.firstMismatch && (
        <span className="dim mono reconcile__detail">
          row {reconciliation.firstMismatch.row}: balance moved{' '}
          {formatMoney(reconciliation.firstMismatch.expectedMinor, currency)} but the row says{' '}
          {formatMoney(reconciliation.firstMismatch.actualMinor, currency)}
        </span>
      )}

      {reconciliation.impliedOpeningBalanceMinor !== null && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={anchor}
            onChange={(event) => onAnchorChange(event.target.checked)}
          />
          <span className="label">
            set opening balance to{' '}
            {formatMoney(reconciliation.impliedOpeningBalanceMinor, currency)}
          </span>
        </label>
      )}
    </div>
  );
}

function MappingSelect({
  label,
  headers,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  headers: string[];
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allowNone ? 'none' : 'choose…'}</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
    </label>
  );
}
