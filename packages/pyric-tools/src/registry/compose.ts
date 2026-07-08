/**
 * Composes the prod/admin tool registry from the per-domain factories
 * (deploy / rules / firestore data + discover / rtdb). Returns a registry
 * callers iterate and dispatch against: the bridge's prod mode
 * (`startServer({ prodTools })`), the project-audit skill, and
 * firestore-path discovery against a real project.
 *
 * Construct the `adminDeps` / `scope` / `rtdbHost` inputs from a service
 * account via `adminDepsFromServiceAccount` (./admin-deps).
 */

import type { App as AdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import type { Firestore as WebFirestore } from 'firebase/firestore';
import { createToolRegistry, type ToolHandler, type ToolRegistry } from '@inbrowser/agent';
import { fromServiceAccount, type ProjectScope } from '../deploy/index.js';
import {
  createFirestoreDeployTools,
  createRtdbDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
} from '../deploy/index.js';
import { createFirestoreRulesTools } from 'pyric/rules/node';
import { createFirestoreExtractTool } from 'pyric/rules/extract';
import {
  createFirestoreDataTools,
  type Firestore as PyricFirestore,
  type UserAuth,
} from 'pyric/firestore';
import { createFirestoreDiscoverTools } from '../discover/index.js';
import { createAuthAdminTools } from '../auth/index.js';
import { createVerifyTools } from '../verify/index.js';
import { createRtdbDataTools } from 'pyric/database';
import { createRtdbRulesTools, type RtdbHost } from 'pyric/rules/rtdb';

/**
 * Admin SDK deps for the Firestore admin-mode + user-mode dispatch factories.
 */
export interface AdminAppDeps {
  /** firebase-admin App instance. Used directly for admin-mode
   *  Firestore access (`getAdminFirestore(adminApp)`). */
  adminApp: AdminApp;
  /**
   * Resolves to a rules-enforcing client Firestore for the given user.
   * When omitted, data tool calls that supply `auth` fail with a clear
   * UNSUPPORTED error — admin-mode dispatch (no auth) keeps working
   * unchanged. Suppliers typically construct this via
   * `FirebaseServerApp` + `getFirestore` from the Web SDK (see
   * `adminDepsFromServiceAccount` in ./admin-deps).
   */
  getClientFirestore?: (auth: UserAuth) => Promise<WebFirestore>;
}

function createFirestoreAdminDataTools(deps: AdminAppDeps): ToolHandler[] {
  // The admin SDK's Firestore has a structurally-compatible subset of
  // the Web SDK's modular surface that `createFirestoreDataTools` uses
  // (doc/collection/getDoc/setDoc/etc.). The cast collapses the nominal
  // mismatch; runtime behavior is identical.
  const adminFs = getAdminFirestore(deps.adminApp) as unknown as PyricFirestore;
  return createFirestoreDataTools({
    resolveDb: async (actor) => {
      // 'admin' (or omitted) → admin SDK (rules bypassed). A specific user
      // requires a wired client-Firestore factory for rules-enforcing dispatch.
      if (!actor || actor === 'admin') return adminFs;
      if (!deps.getClientFirestore) {
        throw new Error(
          'firestore data tool: user-mode (as:{uid}) requires AdminAppDeps.getClientFirestore. ' +
            'Supply it to enable rules-enforcing dispatch.',
        );
      }
      const userFs = await deps.getClientFirestore(actor);
      return userFs as unknown as PyricFirestore;
    },
  });
}

function createFirestoreAdminDiscoverTools(deps: AdminAppDeps): ToolHandler[] {
  return createFirestoreDiscoverTools({
    resolveDb: () => getAdminFirestore(deps.adminApp) as never,
  });
}

export type Profile = 'full' | 'browser-parity' | 'control-plane-only';

export interface ComposeOptions {
  profile?: Profile;
  scope?: ProjectScope;
  /**
   * Admin SDK deps for Firestore admin-mode + user-mode dispatch.
   * When supplied, `composeMcpRegistry` wires the Firestore data /
   * discover / extract factories. Without it, only the scope-based
   * control-plane + rules tooling is registered (`browser-parity`
   * profile flow).
   */
  adminDeps?: AdminAppDeps;
  /**
   * RTDB host — when supplied, RTDB admin tools register. Construct
   * via `initializeDatabaseApp(...)` from `@pyric/rtdb`. Passed
   * separately from `adminDeps` so RTDB and Firestore admin surfaces
   * opt in independently. Skipped in `browser-parity` profile.
   */
  rtdbHost?: RtdbHost;
}

/**
 * Compose the MCP server's tool registry from the per-domain
 * factories. Returns a registry the MCP server iterates +
 * dispatches against.
 *
 * Profile gates the tool surface:
 *   - `full` (default): control-plane + rules tooling.
 *   - `browser-parity`: skips Node-only Admin SDK tools so a human
 *     running the MCP server locally previews what the browser
 *     playground sees.
 *   - `control-plane-only`: just the deploy primitives — useful
 *     for sandboxed Deployment Agent runs.
 */
export async function composeMcpRegistry(
  opts: ComposeOptions = {},
): Promise<ToolRegistry> {
  const profile: Profile = opts.profile ?? 'full';
  const scope =
    opts.scope ??
    (await fromServiceAccount(process.env.FIREBASE_SA_BASE64 ?? ''));

  const registry = createToolRegistry();
  // Pre-mortem M12 — typed ToolHandler[][] instead of unknown[][].
  // Surfaces shape drift at the call site if a factory's return
  // type ever stops being ToolHandler-compatible.
  const factories: ToolHandler[][] = [
    // Control plane — every profile.
    createFirestoreDeployTools({ scope }),
    ...(opts.rtdbHost && profile !== 'browser-parity' ? [] : [createRtdbDeployTools({ scope })]),
    createHostingDeployTools({ scope }),
    createFunctionsDeployTools({ scope }),
    // Rules tooling — full + browser-parity.
    ...(profile !== 'control-plane-only'
      ? [createFirestoreRulesTools({ scope })]
      : []),
    // Auth configuration (Identity Toolkit) — full + browser-parity.
    ...(profile !== 'control-plane-only'
      ? [createAuthAdminTools({ scope })]
      : []),
    ...(profile !== 'control-plane-only'
      ? [createVerifyTools({ scope })]
      : []),
    // Admin SDK + RTDB tools — only when `adminDeps` is supplied and
    // we're not in a profile that explicitly excludes Node-only paths.
    // `extract` is pure static analysis so it lands regardless of
    // `adminDeps` when not in `browser-parity` (it reads from disk).
    ...(profile !== 'control-plane-only' && profile !== 'browser-parity'
      ? [[createFirestoreExtractTool()]]
      : []),
    ...(opts.adminDeps && profile !== 'browser-parity'
      ? [
          createFirestoreAdminDataTools(opts.adminDeps),
          createFirestoreAdminDiscoverTools(opts.adminDeps),
        ]
      : []),
    ...(opts.rtdbHost && profile !== 'browser-parity'
      ? [
          createRtdbRulesTools({ host: opts.rtdbHost }),
          createRtdbDataTools({ host: opts.rtdbHost }),
        ]
      : []),
  ];
  for (const handlers of factories) {
    for (const h of handlers) registry.register(h);
  }
  return registry;
}
