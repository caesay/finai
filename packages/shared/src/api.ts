/**
 * Contracts shared between the API server and the web client.
 * Keep this file free of runtime dependencies so both sides can import it cheaply.
 */

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  version: string;
}

/** Response body of `GET /api/codex/status`. */
export interface CodexStatusResponse {
  codexHome: string;
  authenticated: boolean;
}

/** Shape returned by the API for any handled error. */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
