# finai

Personal finance tracker for a single-user homelab deployment. Node + TypeScript
API, React front end, one Docker image, published to `ghcr.io/caesay/finai`.

## Shape of the repo

```
packages/shared   @finai/shared — API contracts imported by both sides
apps/server       @finai/server — Fastify API, SQLite, Codex integration
apps/web          @finai/web    — Vite + React client
```

`npm run dev` runs all three with reload: `tsc --watch` on the shared package,
`tsx watch` on the server (it also watches `packages/shared/dist`), and Vite for
the client, which aliases `@finai/shared` to its TypeScript source.

## Conventions that are easy to get wrong

**No users, no auth.** Anything that can reach the front end is authorized; an
SSO reverse proxy sits in front of the deployment. Do not add login flows or
per-user scoping without being asked.

**Money is integer minor units.** Every amount crossing the wire or sitting in
the database is a whole number of cents. Negative means money left the account.
Format only at the edge, with `formatMoney` in `apps/web/src/lib/money.ts`.

**Account balances are derived**, never stored: `openingBalanceMinor` plus the
sum of the account's transactions. Editing or deleting a transaction therefore
cannot desynchronise a balance.

**Timestamps are ISO-8601 strings** so they round-trip identically through
SQLite and Postgres.

## CSV import

The assistant's only job is naming columns; `import/mapping.ts` does the
conversion mechanically, so the preview is exactly what gets written and a
column name the model invented is dropped rather than trusted.

When a statement carries a running balance, that balance is treated as the
truth:

- It is stored per transaction as `statementBalanceMinor` — the bank's own
  figure, never recomputed.
- It anchors the account's `openingBalanceMinor` to the balance before the
  earliest row, so the derived balance agrees with the bank.
- Where a row's amount does not explain the step between two balances,
  something upstream is missing or duplicated, and the import inserts a
  `kind: 'adjustment'` transaction carrying the difference. Those render red;
  they are never silently absorbed.
- It stands in as a dedupe key when the file has no reference column, since no
  two rows leave an account at the same figure on the same day for the same
  amount. Without a balance column rows stay unkeyed, so re-importing an
  overlapping statement will duplicate them.

A separately billed fee is folded into the transaction amount, because that is
what actually left the account and it is what makes the balance reconcile.

## Database

SQLite through Drizzle, opened in `apps/server/src/db/client.ts`. Migrations are
plain SQL in `apps/server/src/db/migrations.ts`, applied in order and recorded in
`schema_migrations`; they are append-only, so never edit one that has shipped.

Postgres is the intended growth path. Routes and services never touch SQL — they
go through the repositories in `apps/server/src/db/repositories/`, so a move
means rewriting `schema.ts`, `migrations.ts`, `client.ts` and the inside of the
repositories, and nothing else. `DATABASE_URL=:memory:` gives a throwaway
database, which is what the tests use.

## Automations

Automations run when a transaction is created or imported. They execute in
`sortOrder` and **the first one that changes the transaction wins**, like a mail
filter chain — put cheap deterministic rules above AI ones, because an AI
automation spends a Codex turn per transaction. A transaction that arrives with
a category already set skips the chain entirely.

Two kinds: `rule` (all conditions must match; the automation names the category)
and `ai` (a plain-language prompt; the assistant picks from the existing
category names and anything unrecognised counts as no match).

Every change an automation makes is written to `audit_events`. User edits are
recorded too, but the Audit page filters them out by default.

## Codex

The Codex SDK drives the `codex` CLI, which the Docker image installs globally.
Credentials come from `CODEX_HOME` (`/data/codex`, a mounted volume), so a single
`codex login` covers both the chat assistant and AI automations and inference is
billed to the subscription rather than to an API key.

## Icons

Icons come from the **Icons8 MCP server**, style **`forma-light-sharp`**
("Forma Light Sharp") — thin, sharp-cornered line icons on a 24px grid, which
matches the hairline borders and 2px radii of the UI. Every new icon must come
from that same style so the set stays coherent.

Fetch with `mcp__icons8mcp__get_icon_svg` and inline the path into
`apps/web/src/components/icons.tsx`; icons are never loaded over the network.
Strip any hard-coded fill so they inherit `currentColor`.

The favicon is the one deliberate exception: `apps/web/public/favicon.svg` uses
Icons8 "Bot" in `forma-bold-filled-sharp`, because thin strokes turn to mush at
16px.

## Visual language

Dark and technical: near-black ground, hairline `#ffffff0d` borders, a single
cyan accent (`#22d3ee`), 2px radii, and uppercase letter-spaced monospace for
labels. Tokens live at the top of `apps/web/src/styles.css` — use them rather
than literal colours.

## Checks

`npm run build`, `npm run lint`, `npm test` all have to pass; CI runs them plus a
Docker build on every push, and publishes the image from `main`.
