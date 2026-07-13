/**
 * `pyric auth:*` subcommands — thin wrappers over `@pyric/cli/auth`.
 *
 *   - `auth:configure-provider <provider> <enabled>` — toggle one of
 *     the Identity Toolkit providers (anonymous / email / phone /
 *     google).
 *   - `auth:manage-domains <add|remove|list> [domain]` — manage
 *     authorized domains for the project's auth config.
 *
 * Both call `getAuthTools(scope)` from `@pyric/cli/auth`. ProjectScope
 * is resolved from env (FIREBASE_SA_BASE64 / GOOGLE_APPLICATION_CREDENTIALS)
 * by the shared `resolveScope` helper.
 */

import { getAuthTools, type AuthTools } from '../auth/index.js';
import type { ParsedArgs } from './parse-args.js';
import type { ProjectScope } from '../credentials/core/types.js';
import { resolveScope } from './scope.js';
import { readFirebaseRc } from './firebase-json.js';

export interface AuthDeps {
  resolveScope?: (opts: { projectId?: string }) => Promise<{ scope: ProjectScope; source: string }>;
  getAuthTools?: (scope: ProjectScope) => AuthTools;
  readFirebaseRc?: typeof readFirebaseRc;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

async function resolveScopeFromArgs(
  parsed: ParsedArgs,
  deps: AuthDeps,
): Promise<{ scope: ProjectScope; source: string } | null> {
  const flagProject = parsed.flags.get('project');
  const explicit = typeof flagProject === 'string' ? flagProject : undefined;
  let projectIdHint = explicit;
  if (!projectIdHint) {
    const rcRead = deps.readFirebaseRc ?? readFirebaseRc;
    const rc = await rcRead(deps.cwd ?? process.cwd()).catch(() => null);
    projectIdHint = rc?.projects?.default ?? undefined;
  }
  const resolveScopeFn = deps.resolveScope ?? resolveScope;
  return resolveScopeFn({ projectId: projectIdHint });
}

export async function runAuthConfigureProvider(
  parsed: ParsedArgs,
  deps: AuthDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;

  const provider = parsed.positional[0];
  const enabledArg = parsed.positional[1];
  if (!provider || !enabledArg) {
    err.write(
      'pyric auth:configure-provider: missing args. Usage: pyric auth:configure-provider <anonymous|email|phone|google> <true|false>\n',
    );
    return 1;
  }
  if (provider !== 'anonymous' && provider !== 'email' && provider !== 'phone' && provider !== 'google') {
    err.write(
      `pyric auth:configure-provider: unknown provider '${provider}'. Must be one of anonymous, email, phone, google.\n`,
    );
    return 1;
  }
  if (enabledArg !== 'true' && enabledArg !== 'false') {
    err.write(
      `pyric auth:configure-provider: enabled must be 'true' or 'false', got '${enabledArg}'.\n`,
    );
    return 1;
  }
  const enabled = enabledArg === 'true';

  let scope: ProjectScope;
  try {
    const resolved = await resolveScopeFromArgs(parsed, deps);
    if (!resolved) {
      err.write('pyric auth:configure-provider: failed to resolve project scope.\n');
      return 1;
    }
    scope = resolved.scope;
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const tools = (deps.getAuthTools ?? getAuthTools)(scope);
  try {
    const result = await tools.configureProvider({ provider, enabled });
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 2;
  } catch (e) {
    err.write(`pyric auth:configure-provider: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

export async function runAuthManageDomains(
  parsed: ParsedArgs,
  deps: AuthDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;

  const action = parsed.positional[0];
  const domain = parsed.positional[1];
  if (!action) {
    err.write(
      'pyric auth:manage-domains: missing action. Usage: pyric auth:manage-domains <add|remove|list> [domain]\n',
    );
    return 1;
  }
  if (action !== 'add' && action !== 'remove' && action !== 'list') {
    err.write(
      `pyric auth:manage-domains: unknown action '${action}'. Must be add, remove, or list.\n`,
    );
    return 1;
  }
  if ((action === 'add' || action === 'remove') && !domain) {
    err.write(`pyric auth:manage-domains: action '${action}' requires a domain argument.\n`);
    return 1;
  }

  let scope: ProjectScope;
  try {
    const resolved = await resolveScopeFromArgs(parsed, deps);
    if (!resolved) {
      err.write('pyric auth:manage-domains: failed to resolve project scope.\n');
      return 1;
    }
    scope = resolved.scope;
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const tools = (deps.getAuthTools ?? getAuthTools)(scope);
  try {
    // `action` is narrowed to the literal union above; the assignment
    // here re-narrows after the positional destructure (TS otherwise
    // widens to `string` when constructing an object literal).
    const narrowedAction: 'add' | 'remove' | 'list' = action;
    const input = domain
      ? { action: narrowedAction, domain }
      : { action: narrowedAction };
    const result = await tools.manageDomains(input);
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : 2;
  } catch (e) {
    err.write(`pyric auth:manage-domains: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
