import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';

import type { Config } from '../config.js';

/**
 * The Codex SDK drives the local `codex` CLI, which reads its credentials from
 * CODEX_HOME. Authenticating once (`codex login`, or
 * `docker compose exec -it finai codex login` in the container) lets every
 * request here run against the Codex subscription instead of a metered API key.
 *
 * The agent reaches this app's data through the MCP server on `/api/mcp` and
 * through nothing else. The shell and the browser are switched off at the
 * feature flag rather than merely sandboxed, so the model is never offered them
 * and cannot go looking for the database on disk — an agent that can read
 * `finai.sqlite` directly is one bad idea away from a corrupt ledger, and one
 * that shells around a container is answering questions nobody asked.
 */
export function createCodex(config: Config): Codex {
  // Setting CODEX_HOME on this process means the SDK's child process inherits
  // it; passing `env` explicitly would replace the whole environment instead.
  process.env.CODEX_HOME = config.codexHome;

  return new Codex({
    ...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
    config: {
      mcp_servers: {
        finai: { url: `http://127.0.0.1:${String(config.port)}/api/mcp` },
      },
      features: {
        // Every one of these is a way out of the app and into the machine.
        shell_tool: false,
        unified_exec: false,
        browser_use: false,
        browser_use_external: false,
        computer_use: false,
      },
    },
  });
}

/**
 * Default guard rails for agent turns.
 *
 * `workingDirectory` is a directory kept empty on purpose. With the shell gone
 * nothing should be reading it at all; pointing it away from DATA_DIR means
 * that if a future Codex release hands the model a file tool anyway, what it
 * finds is nothing rather than the database.
 */
export const DEFAULT_THREAD_OPTIONS: ThreadOptions = {
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  skipGitRepoCheck: true,
};

/** Options every thread shares, including the empty working directory. */
export function threadOptions(config: Config, extra?: ThreadOptions): ThreadOptions {
  return {
    ...DEFAULT_THREAD_OPTIONS,
    workingDirectory: agentDirectory(config),
    ...(config.codexModel ? { model: config.codexModel } : {}),
    ...extra,
  };
}

export function startThread(codex: Codex, options?: ThreadOptions): Thread {
  return codex.startThread({ ...DEFAULT_THREAD_OPTIONS, ...options });
}

export function agentDirectory(config: Config): string {
  return join(config.dataDir, 'agent');
}

/** Created at startup so a turn never fails on a missing working directory. */
export async function ensureAgentDirectory(config: Config): Promise<void> {
  await mkdir(agentDirectory(config), { recursive: true });
}

export interface CodexStatus {
  /** Directory the CLI reads credentials from. */
  codexHome: string;
  /** True when `auth.json` exists, i.e. `codex login` has been completed. */
  authenticated: boolean;
}

/** Cheap readiness probe that never starts a turn, so it costs no inference. */
export async function getCodexStatus(config: Config): Promise<CodexStatus> {
  const authFile = join(config.codexHome, 'auth.json');
  const authenticated = await access(authFile).then(
    () => true,
    () => false,
  );

  return { codexHome: config.codexHome, authenticated };
}
