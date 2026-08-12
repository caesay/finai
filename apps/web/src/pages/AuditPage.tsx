import type { AuditActor } from '@finai/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { listAudit } from '../api/finance.js';
import { PageHeader } from '../components/Shell.js';
import { LoadingLine, Spinner } from '../components/Spinner.js';
import { formatDateTime } from '../lib/money.js';

/**
 * Every change an automation made. User edits are tracked too but hidden by
 * default — the point of this page is auditing what ran unattended.
 */
export function AuditPage() {
  const [includeUser, setIncludeUser] = useState(false);
  const [page, setPage] = useState(1);

  const actors: AuditActor[] = includeUser
    ? ['automation', 'user', 'assistant', 'system']
    : ['automation'];

  const audit = useQuery({
    queryKey: ['audit', { actors, page }],
    queryFn: () => listAudit({ actors, page, pageSize: 50 }),
  });

  const totalPages = audit.data?.totalPages ?? 1;

  return (
    <>
      <PageHeader
        title="Audit"
        description="Changes made automatically, newest first."
        actions={
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeUser}
              onChange={(event) => {
                setIncludeUser(event.target.checked);
                setPage(1);
              }}
            />
            <span className="label">include my changes</span>
          </label>
        }
      />

      {audit.isError && <p className="error">{audit.error.message}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {audit.data?.items.map((event) => (
              <tr key={event.id}>
                <td className="mono nowrap">{formatDateTime(event.at)}</td>
                <td>
                  <span className={`chip chip--${event.actor}`}>{event.actor}</span>
                  {event.actorName && <span className="dim"> {event.actorName}</span>}
                </td>
                <td className="dim">
                  {event.entity} · {event.action}
                </td>
                <td>
                  <div className="cell-stack">
                    <span>{event.summary}</span>
                    {event.changes.map((change) => (
                      <span key={change.field} className="dim cell-note mono">
                        {change.field}: {change.from ?? '∅'} → {change.to ?? '∅'}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}

            {audit.isPending && (
              <tr>
                <td colSpan={4} className="table__empty">
                  <LoadingLine>Loading audit events…</LoadingLine>
                </td>
              </tr>
            )}

            {!audit.isPending && audit.data?.items.length === 0 && (
              <tr>
                <td colSpan={4} className="dim table__empty">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <span className="label">{audit.data?.total ?? 0} events</span>

        <div className="pager">
          {audit.isFetching && !audit.isPending && <Spinner label="Refreshing audit events" />}
          <span className="label">
            page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="button button--ghost"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            prev
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            next
          </button>
        </div>
      </div>
    </>
  );
}
