/**
 * `createAuthAdminTools({ scope })` — Identity Toolkit-driven auth
 * tooling as `ToolHandler[]`, consumable by `@inbrowser/agent`'s
 * registry. Mirrors `@pyric/rtdb`'s `createRtdbAdminTools` shape: a
 * scope in, JSON-Schema-typed `ToolHandler`s out.
 *
 * Three tools:
 *   - `auth_get_config` — fetch the IR (enabled providers + settings)
 *   - `auth_configure_provider` — enable/disable a provider
 *   - `auth_manage_domains` — add/remove/list authorized domains
 *
 * For the legacy `getAgentTools(app)` path (which wraps these as
 * `AgentTool[]` via sdk-side `defineTool` + zod), use
 * `getAuthTools(scope)` instead — same backing handlers, different
 * surface.
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { ProjectScope } from 'pyric-tools/deploy';
import { getAuthTools } from './resolver.js';
import type { ConfigureProviderInput } from './provider/spec.js';
import type { ManageDomainsInput } from './domains/spec.js';

export interface AuthAdminToolDeps {
  scope: ProjectScope;
}

export function createAuthAdminTools(deps: AuthAdminToolDeps): ToolHandler[] {
  const auth = getAuthTools(deps.scope);

  return [
    {
      name: 'auth_get_config',
      description:
        'Fetch the authentication configuration for this Firebase project. Returns enabled sign-in providers (Google, email/password, phone, anonymous) and auth settings like whether password signup and anonymous auth are enabled.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const ir = await auth.generateIR();
        return { ok: true, summary: `${ir.enabledProviders.length} providers enabled`, data: ir };
      },
    },
    {
      name: 'auth_configure_provider',
      description:
        'Enable or disable an authentication provider. Supports four providers that require no external credentials: anonymous (instant), email/password (instant), phone (requires billing for SMS), and Google (auto-provisioned OAuth client). Returns the new state. Use auth_get_config first to see current configuration.',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['anonymous', 'email', 'phone', 'google'],
            description: 'The auth provider to configure: anonymous, email, phone, or google',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether to enable (true) or disable (false) the provider',
          },
        },
        required: ['provider', 'enabled'],
      },
      async execute(args) {
        const result = await auth.configureProvider(args as ConfigureProviderInput);
        return {
          ok: result.success,
          summary: result.success
            ? `${result.provider} ${result.enabled ? 'enabled' : 'disabled'}`
            : `Failed: ${result.error.message}`,
          data: result,
        };
      },
    },
    {
      name: 'auth_manage_domains',
      description:
        'Add, remove, or list authorized domains for OAuth redirects. When deploying to a new hosting site, add its domain here or Google sign-in and other OAuth providers will fail with a redirect error. Use action "list" to see current domains, "add" to authorize a new domain, "remove" to revoke.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'list'],
            description:
              'Action to perform: add a domain, remove a domain, or list all authorized domains',
          },
          domain: { type: 'string', description: 'Domain to add or remove (omit for list)' },
        },
        required: ['action'],
      },
      async execute(args) {
        const result = await auth.manageDomains(args as ManageDomainsInput);
        return {
          ok: result.success,
          summary: result.success
            ? `${result.authorizedDomains.length} authorized domain(s)`
            : `Failed: ${result.error.message}`,
          data: result,
        };
      },
    },
  ];
}
