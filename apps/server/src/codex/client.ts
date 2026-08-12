import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';

import type { Config } from '../config.js';

/**
 * The Codex SDK drives the local `codex` CLI, which reads its credentials from
 * CODEX_HOME. Authenticating once (`codex login`, or
 * `docker compose exec -it finai codex login` in the container) lets every
 * request here run against the Codex subscription instead of a metered API key.
 */
export function createCodex(config: Config): Codex {
  // Setting CODEX_HOME on this process means the SDK's child process inherits
  // it; passing `env` explicitly would replace the whole environment instead.
  process.env.CODEX_HOME = config.codexHome;

  return new Codex(config.codexPath ? { codexPathOverride: config.codexPath } : {});
}

/** Default guard rails for agent turns: no writes, no approval prompts. */
export const DEFAULT_THREAD_OPTIONS: ThreadOptions = {
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  skipGitRepoCheck: true,
};

export function startThread(codex: Codex, options?: ThreadOptions): Thread {
  return codex.startThread({ ...DEFAULT_THREAD_OPTIONS, ...options });
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
