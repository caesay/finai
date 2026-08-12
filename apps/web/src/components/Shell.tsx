import type { ReactNode } from 'react';

/** App chrome: wordmark header, content column, build-info footer. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell__header">
        <span className="wordmark">finai</span>
        <span className="label">personal finance</span>
      </header>

      <main className="shell__main">{children}</main>

      <footer className="shell__footer">
        <span className="label">local deployment · not internet facing</span>
      </footer>
    </div>
  );
}
