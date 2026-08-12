import type { ConnectionProviderId } from '@finai/shared';

import type { Config } from '../../config.js';
import { createLunchflowProvider } from './lunchflow.js';
import type { ConnectionProvider } from './types.js';

export type ProviderRegistry = Record<ConnectionProviderId, ConnectionProvider>;

/** Every provider the server can talk to, built once at startup. */
export function createProviders(config: Config): ProviderRegistry {
  return { lunchflow: createLunchflowProvider(config.lunchflowApiUrl) };
}

export function providerFor(
  providers: ProviderRegistry,
  id: string,
): ConnectionProvider | undefined {
  return providers[id as ConnectionProviderId];
}
