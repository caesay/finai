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

## Connections

A connection is an account aggregator holding credentials for one or more
remote accounts. LunchFlow is the only one today; only
`apps/server/src/connections/providers/` knows that, because everything above it
speaks the three-call `ConnectionProvider` interface — list accounts, list
transactions, read a balance — so a second aggregator is a new file there and an
entry in the registry.

Remote accounts are not accounts. Each one is reviewed and either linked to an
existing account, used to create a new one, or ignored; the assistant proposes
that mapping and defaults to creating rather than linking when it is unsure,
since linking the wrong account mixes two histories together. Nothing is
imported until the review is confirmed.

- A sync only asks for transactions dated on or after the newest one the
  account already holds, and enforces that on the way back in case the provider
  ignores the filter. An account with nothing in it takes full history instead.
- The dedupe key is `<provider>:<remote id>`, so an overlapping window costs
  nothing. Pending rows have no id, so they are never imported.
- `anchorBalance` re-derives the account's `openingBalanceMinor` from the
  provider's balance after each sync, which is what makes an account created
  from a partial feed agree with the bank. It defaults on for accounts a
  connection creates and off for accounts that already had history.
- Open banking consent lasts 90 days, so `disconnected` is a resting state, not
  a failure: it is recorded against the link and shown under the account on the
  Accounts page, because otherwise a dead feed looks like a quiet month.
- `CONNECTION_SYNC_INTERVAL_MINUTES` drives the background timer; 0 disables it.

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

**Running one over transactions already here** is a separate path
(`automations/backfill.ts`, "run on existing" on the Automations page). Only the
chosen automation runs — first-match-wins exists to stop every AI automation
being billed for one arriving transaction, and has nothing to say about a
deliberate backfill. A dry run is the same code with the writes left out, so the
figures in the confirmation dialog come from the run that is about to happen.
Candidates are collected before anything is written, because setting a category
changes whether a row still matches the filter it was selected under. An AI
backfill is capped at 200 transactions and cannot be previewed — counting its
matches costs the same turns as running it.

## Codex

The Codex SDK drives the `codex` CLI, which the Docker image installs globally.
Credentials come from `CODEX_HOME` (`/data/codex`, a mounted volume), so a single
`codex login` covers both the chat assistant and AI automations and inference is
billed to the subscription rather than to an API key.

**The agent has no shell and no filesystem.** `shell_tool`, `unified_exec`,
`browser_use` and `computer_use` are switched off through Codex feature flags in
`codex/client.ts`, so the model is never offered them and does not go hunting
for the database on disk. Every thread also runs in `DATA_DIR/agent`, which is
kept empty, so a future Codex release that hands out a file tool anyway finds
nothing. Use `threadOptions(config)` to start a thread — never hand-roll the
options, or a turn will end up pointed at the data directory again.

Its reach is `mcp/tools.ts`, served over streamable HTTP at `/api/mcp` by this
same server (so tools share the repositories the routes use) and registered with
the CLI via config overrides. Reads are broad; writes are narrow on purpose —
categorize a transaction, and create, edit, delete or run an automation. There
is deliberately no tool that creates or deletes a transaction, account or
connection: those record what a bank did, and the assistant gets opinions about
them rather than authorship. Every write it makes is audited as `assistant`.

A tool that fails returns `isError` with an explanation rather than throwing, so
the model can correct itself instead of the turn dying.

The sparkle on a transaction writes a question into the chat box and opens it.
It does not send: you choose whether it goes to the conversation already open or
a new one, and you can edit it first. There is no server-side proposal flow any
more — the assistant proposes a rule by talking, and creates it with
`create_automation` like any other tool call.

`default_tools_approval_mode = "approve"` on the MCP server is load-bearing.
Without it every tool call raises a permission request, and a turn started by an
HTTP request has nobody to answer it — the CLI resolves it as "user cancelled
MCP tool call" and the agent reports, convincingly and wrongly, that it has no
access. Approving up front is safe precisely because the tool list is the
boundary.

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
