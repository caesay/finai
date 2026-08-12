import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Port the HTTP server listens on. */
  PORT: z.coerce.number().int().positive().default(3000),
  /** Bind address. 0.0.0.0 so the container is reachable from the host. */
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Absolute or relative path to the built web client. When set, the server
   * serves it as static files and handles SPA fallback.
   */
  WEB_DIST: z.string().optional(),
  /**
   * Directory holding Codex CLI config and OAuth credentials. The SDK shells
   * out to the `codex` binary, which reads this location, so authenticating
   * once with `codex login` is enough — no separate API key is billed.
   */
  CODEX_HOME: z.string().optional(),
  /** Explicit path to the `codex` binary when it is not on PATH. */
  CODEX_PATH: z.string().optional(),
  /** Model the agent runs on. Unset means the Codex CLI default. */
  CODEX_MODEL: z.string().optional(),
  /** Root for persisted application state (chat transcripts and the database). */
  DATA_DIR: z.string().default('./data'),
  /**
   * Where the database lives. Empty means a SQLite file inside DATA_DIR;
   * ':memory:' gives a throwaway database, which is what tests use. A Postgres
   * URL is the intended growth path.
   */
  DATABASE_URL: z.string().default(''),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;
  webDist: string | undefined;
  codexHome: string;
  codexPath: string | undefined;
  codexModel: string | undefined;
  dataDir: string;
  databaseUrl: string;
  version: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const value = parsed.data;

  return {
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    webDist: value.WEB_DIST,
    codexHome: value.CODEX_HOME ?? join(homedir(), '.codex'),
    codexPath: value.CODEX_PATH,
    codexModel: value.CODEX_MODEL,
    dataDir: resolve(value.DATA_DIR),
    databaseUrl: value.DATABASE_URL,
    version: env.npm_package_version ?? '0.0.1',
  };
}
