import type { Automation, AutomationBackfillResult } from '@finai/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { backfillAutomation } from '../api/finance.js';
import { formatDate, formatMoney } from '../lib/money.js';
import { LoadingLine, Spinner } from './Spinner.js';

/**
 * Runs one automation over transactions that are already here.
 *
 * The dialog opens on a dry run and will not offer to apply anything until that
 * has come back, so the count and the sample below it describe the run that is
 * about to happen rather than an estimate of it. Only the chosen automation
 * runs — this is not the import-time chain, where the first match wins.
 */
export function AutomationRunDialog({
  automation,
  onClose,
}: {
  automation: Automation;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [onlyUncategorized, setOnlyUncategorized] = useState(true);
  const [applied, setApplied] = useState<AutomationBackfillResult | null>(null);

  const preview = useMutation({
    mutationFn: (only: boolean) =>
      backfillAutomation(automation.id, { dryRun: true, onlyUncategorized: only }),
  });

  const apply = useMutation({
    mutationFn: () => backfillAutomation(automation.id, { dryRun: false, onlyUncategorized }),
    onSuccess: async (result) => {
      setApplied(result);
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['automations'] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  // Opening the dialog previews immediately, and changing the filter previews
  // again. Keyed on the filter alone: the mutation object is new on every
  // render, so depending on it would loop.
  useEffect(() => {
    preview.mutate(onlyUncategorized);
  }, [onlyUncategorized]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const result = applied ?? preview.data;
  const isAi = automation.kind === 'ai';
  const canApply = preview.data !== undefined && !preview.isPending && !apply.isPending;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Run automation">
      <div className="modal__panel">
        <header className="modal__head">
          <span className="label">run “{automation.name}” on existing transactions</span>
          <button type="button" className="button button--ghost" onClick={onClose}>
            close
          </button>
        </header>

        <div className="modal__body">
          {applied ? (
            <div className="import-done">
              <p>
                Updated <strong>{applied.changed}</strong> transactions
                {applied.recategorized > 0 &&
                  `, ${applied.recategorized} of which already had another category`}
                .
              </p>
              {applied.skipped > 0 && (
                <p className="error">
                  {applied.skipped} transactions were left out because the run hit its ceiling. Run
                  it again to continue.
                </p>
              )}
              <button type="button" className="button" onClick={onClose}>
                done
              </button>
            </div>
          ) : (
            <>
              {preview.isPending && <LoadingLine>Working out what this would change…</LoadingLine>}
              {preview.isError && <p className="error">{preview.error.message}</p>}

              {result && !preview.isPending && (
                <>
                  <p className="run-headline">
                    {result.estimateOnly ? (
                      <>
                        This AI automation would be asked about <strong>{result.considered}</strong>{' '}
                        {result.considered === 1 ? 'transaction' : 'transactions'}.
                      </>
                    ) : result.changed === 0 ? (
                      <>
                        Nothing to do — this rule matches nothing among the {result.considered}{' '}
                        {result.considered === 1 ? 'transaction' : 'transactions'} it looked at.
                      </>
                    ) : (
                      <>
                        This will update <strong>{result.changed}</strong> of {result.considered}{' '}
                        transactions. Are you sure?
                      </>
                    )}
                  </p>

                  {/* An AI automation spends a Codex turn per transaction, so the
                      cost of the run scales with the rows, not the click. */}
                  {result.estimateOnly && (
                    <p className="error">
                      Each one costs a Codex turn, and the matches cannot be previewed without
                      spending them.
                    </p>
                  )}

                  {result.recategorized > 0 && (
                    <p className="error">
                      {result.recategorized} of those already have a different category, which this
                      will overwrite.
                    </p>
                  )}

                  {result.skipped > 0 && (
                    <p className="error">
                      {result.skipped} more match the filter than a single run will take on. The
                      oldest are done first; run it again to continue.
                    </p>
                  )}

                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!onlyUncategorized}
                      disabled={preview.isPending || apply.isPending}
                      onChange={(event) => setOnlyUncategorized(!event.target.checked)}
                    />
                    <span className="label">include transactions that already have a category</span>
                  </label>

                  {result.changes.length > 0 && (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Description</th>
                            <th>Category</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.changes.map((change) => (
                            <tr key={change.transactionId}>
                              <td className="mono nowrap">{formatDate(change.postedAt)}</td>
                              <td>{change.description}</td>
                              <td>
                                <span className="dim">{change.fromCategoryName ?? 'none'}</span>
                                <span className="proposal__arrow"> → </span>
                                <span>{change.toCategoryName}</span>
                              </td>
                              <td
                                className={`mono ${change.amountMinor < 0 ? 'amount--negative' : 'amount--positive'}`}
                              >
                                {formatMoney(change.amountMinor, change.currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {result.changed > result.changes.length && (
                    <p className="dim">
                      Showing the first {result.changes.length} of {result.changed}.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {!applied && (
          <footer className="modal__foot">
            <span className="label">
              {automation.enabled ? '' : 'this automation is disabled, but will still run here'}
            </span>

            <div className="modal__actions">
              {apply.isError && <span className="error">{apply.error.message}</span>}
              <button type="button" className="button button--ghost" onClick={onClose}>
                cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!canApply || (!isAi && (preview.data?.changed ?? 0) === 0)}
                onClick={() => apply.mutate()}
              >
                {apply.isPending && <Spinner label="Running the automation" />}
                {apply.isPending
                  ? 'running'
                  : isAi
                    ? `run on ${String(preview.data?.considered ?? 0)} transactions`
                    : `update ${String(preview.data?.changed ?? 0)} transactions`}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
