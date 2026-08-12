import type { CodexStatusResponse, HealthResponse } from '@finai/shared';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../api/client.js';

/**
 * Placeholder home screen. Real finance views replace this; for now it reports
 * whether the backend and the Codex agent are ready.
 */
export function DashboardPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
  });

  const codex = useQuery({
    queryKey: ['codex-status'],
    queryFn: () => apiFetch<CodexStatusResponse>('/codex/status'),
  });

  return (
    <>
      <h1 className="title">Dashboard</h1>
      <p className="dim">
        Nothing to show yet. Use the assistant in the corner — it is the primary way to work with
        finai.
      </p>

      <div className="rows">
        <div className="row">
          <span className="label">server</span>
          <span className="mono dim">
            {health.data ? `ok · v${health.data.version} · ${health.data.uptimeSeconds}s` : '—'}
          </span>
        </div>
        <div className="row">
          <span className="label">codex auth</span>
          <span className="mono dim">
            {codex.data ? (codex.data.authenticated ? 'signed in' : 'run codex login') : '—'}
          </span>
        </div>
        <div className="row">
          <span className="label">codex home</span>
          <span className="mono dim">{codex.data?.codexHome ?? '—'}</span>
        </div>
      </div>
    </>
  );
}
