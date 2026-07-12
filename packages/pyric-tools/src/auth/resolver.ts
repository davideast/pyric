/**
 * `getAuthTools(scope)` — programmatic auth admin API. Returns the
 * {@link AuthTools} surface backed by Identity Toolkit calls under a
 * {@link ProjectScope}.
 *
 * Per F3, every primitive takes ProjectScope. Per F4, callers invoke
 * `resolveToken()` per call — no token caching at this layer.
 *
 * `fetchIdentityToolkit` (the helper that used to hang off AgentApp)
 * inlines here as a thin Bearer-token fetch wrapper — that's all the
 * old `app.fetchIdentityToolkit` was.
 */
import type { ProjectScope } from '@pyric/cli/deploy';
import type { AuthTools, AuthIR } from './types.js';
import { AuthMapper } from './mapper.js';
import { ConfigureProviderHandler } from './provider/handler.js';
import { ManageDomainsHandler } from './domains/handler.js';

const IDENTITY_TOOLKIT_BASE = 'https://identitytoolkit.googleapis.com';

async function fetchIdentityToolkit(
  scope: ProjectScope,
  endpointPath: string,
): Promise<Response> {
  const token = await scope.resolveToken();
  return fetch(`${IDENTITY_TOOLKIT_BASE}${endpointPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function getAuthTools(scope: ProjectScope): AuthTools {
  const configureHandler = new ConfigureProviderHandler();
  const domainsHandler = new ManageDomainsHandler();

  return {
    generateIR: async (): Promise<AuthIR> => {
      const [idpRes, configRes] = await Promise.all([
        fetchIdentityToolkit(scope, `/v2/projects/${scope.projectId}/defaultSupportedIdpConfigs`),
        fetchIdentityToolkit(scope, `/v2/projects/${scope.projectId}/config`),
      ]);

      if (!idpRes.ok) throw new Error(`Failed to fetch IDPs: ${idpRes.statusText}`);
      if (!configRes.ok) throw new Error(`Failed to fetch config: ${configRes.statusText}`);

      const idpData = await idpRes.json();
      const configData = await configRes.json();

      return AuthMapper.mapToIR(idpData, configData);
    },
    configureProvider: (input) => configureHandler.execute(scope, input),
    manageDomains: (input) => domainsHandler.execute(scope, input),
  };
}
