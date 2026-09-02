/**
 * Project credentials for the bridge's in-process operations.
 *
 * `firestore_rules.test` and the `rulesTestApi` engine of `pyric.verify`
 * call the Firebase Rules Test API, which needs a `ProjectScope`. Each
 * bridge entry point resolves that scope once, when it composes its
 * in-process handlers, through `resolveScope` in `cli/scope.ts` (the one
 * credential walk: `FIREBASE_SA_BASE64`, `GOOGLE_APPLICATION_CREDENTIALS`,
 * then application default credentials when a project id is known).
 *
 * Resolution never throws out of this module. When no credentials resolve,
 * the scope is `undefined`: the operations stay in the manifest and return
 * their explicit credentials error on use, so a bridge without a project
 * still lists the full contract.
 */
import type { ProjectScope } from '../../credentials/core/types.js';
import { resolveScope, type ResolvedScope } from '../../cli/scope.js';

export interface ResolveBridgeScopeOptions {
  /** Project id from `--project`; `PYRIC_PROJECT` is read by `resolveScope` when omitted. */
  projectId?: string | undefined;
  /** Environment to read credentials from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Credential walk to use. Default: `resolveScope`. */
  resolve?: typeof resolveScope;
}

export type BridgeScopeResolution =
  | { readonly scope: ProjectScope; readonly source: ResolvedScope['source'] }
  | { readonly scope: undefined; readonly reason: string };

/** Resolve project credentials for one bridge; a failure yields `scope: undefined` with the reason. */
export async function resolveBridgeScope(
  options: ResolveBridgeScopeOptions = {},
): Promise<BridgeScopeResolution> {
  try {
    const resolved = await (options.resolve ?? resolveScope)({
      projectId: options.projectId,
      ...(options.env ? { env: options.env } : {}),
    });
    return { scope: resolved.scope, source: resolved.source };
  } catch (error) {
    return { scope: undefined, reason: error instanceof Error ? error.message : String(error) };
  }
}
