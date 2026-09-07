/**
 * Browser-side tool dispatcher. Composes the forwarded tool families from the
 * same records the bridge advertises over MCP (`getSandboxToolMetadata`), so
 * the set the bridge LISTS and the set the page EXECUTES are identical by
 * construction: the records under `../tool-family-records/` pin the names,
 * and `./tool-family-factories.ts` supplies one browser-safe factory per
 * family.
 *
 * History of the trap this guards against: earlier this file delegated to
 * ONLY the simulator factory, while the bridge advertised the simulator,
 * data-plane and inspect families. The bridge therefore LISTED
 * `firestore_create_document` / `sandbox_inspect` etc., but a `callTool`
 * failed at dispatch with "tool 'X' is not registered with the connected
 * sandbox peer" (succeed-at-list, fail-at-dispatch). Composing every family
 * from the records, and deriving `SANDBOX_TOOL_NAMES` from the same records,
 * closes the gap. The parity is pinned by `test/bridge/tool-parity.test.ts`
 * and `test/bridge/tool-families.test.ts`.
 *
 * CALLER IDENTITY. Every dispatch entry point takes an optional `actAs`
 * lens — the identity the bridge holds for its MCP caller
 * (`auth_impersonate` / `auth_reset`), carried here on the `tool-call` frame.
 * It supplies the DEFAULT identity for a call whose own arguments name none.
 * The tool's own `as` argument still wins for that call, and a lens is only
 * consulted by a family that has an identity seam — today the Firestore data
 * family's `resolveDb`. `assertExactToolNames` runs over each identity's
 * binding, so an identity can never change WHICH tools exist, only who they
 * run as.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { getFirestore, getAdminFirestore, type As } from 'pyric/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { AuthLens, LocalSandbox } from 'pyric/sandbox';
import { assertExactToolNames, toolFamilies } from '../tool-families.js';
import { SANDBOX_HANDLER_FACTORIES, type SandboxBinding } from './tool-family-factories.js';

export interface DispatchResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Dispatch one tool by name, optionally under a caller identity. */
export type SandboxDispatch = (
  name: string,
  args: Record<string, unknown>,
  actAs?: AuthLens,
) => Promise<DispatchResult>;

/**
 * The Firestore handle a call's OWN `as` argument names: the literal
 * `'admin'` (or an omitted argument on an identity-less dispatch) bypasses
 * rules, `{ uid, claims? }` enforces them as that user with the claims riding
 * the auth token, matching the rules `request.auth.token` shape.
 */
function actorDb(sandbox: LocalSandbox, actor: As) {
  return actor === 'admin'
    ? getAdminFirestore(sandbox)
    : getFirestore(sandbox.withAuth({ uid: actor.uid, token: actor.claims }));
}

/**
 * The Firestore handle the CALLER'S identity names, used when the call's own
 * arguments name none.
 *
 * `app-session` — the default, and what every caller that never impersonated
 * holds — resolves exactly as an identity-less dispatch always has: the
 * admin-bypass handle, which is the point of agent seeding. `admin` resolves
 * the same way but says so deliberately. `anon` runs genuinely
 * unauthenticated, so rules see `request.auth == null`. `as` freezes the
 * handle to that uid, carrying its tenant and custom claims into rules
 * evaluation.
 */
function callerDb(sandbox: LocalSandbox, caller: AuthLens | undefined) {
  if (caller === undefined || caller.mode === 'app-session' || caller.mode === 'admin') {
    return getAdminFirestore(sandbox);
  }
  if (caller.mode === 'anon') return getFirestore(sandbox.withAuth(null));
  return getFirestore(
    sandbox.withAuth({
      uid: caller.uid,
      ...(caller.token !== undefined ? { token: caller.token } : {}),
      ...(caller.tenant !== undefined ? { tenant: caller.tenant } : {}),
    }),
  );
}

/**
 * The full handler set for a sandbox, bound to one caller identity: every
 * forwarded family bound to one `SandboxBinding` built here.
 *
 * Auth: a call's own `as` argument is resolved by `actorDb` and always wins;
 * with no `as`, the caller identity decides through `callerDb`. This is a
 * SANDBOX dispatcher, so the admin default is intended; a dispatcher wired to
 * a real backend must reject `'admin'`.
 */
function buildSandboxHandlers(sandbox: LocalSandbox, caller?: AuthLens): ToolHandler[] {
  const binding: SandboxBinding = {
    sandbox,
    env: getInternalEnv(sandbox),
    resolveDb: (actor?: As) =>
      actor !== undefined ? actorDb(sandbox, actor) : callerDb(sandbox, caller),
  };
  return toolFamilies('forwarded').flatMap((family) =>
    SANDBOX_HANDLER_FACTORIES[family.key](binding),
  );
}

/** Cache key for one caller identity. Distinct lenses never share a binding. */
function identityKey(caller: AuthLens | undefined): string {
  if (caller === undefined || caller.mode === 'app-session') return 'app-session';
  if (caller.mode === 'admin' || caller.mode === 'anon') return caller.mode;
  return JSON.stringify([caller.uid, caller.tenant ?? null, caller.token ?? null]);
}

/** How many distinct identities keep a bound handler set before the cache resets. */
const IDENTITY_CACHE_LIMIT = 16;

/**
 * Build a dispatcher for the supplied `Sandbox`. The returned function
 * looks up tools by name across every family and invokes the
 * canonical handler. Throws `UnknownToolError` on unknown names.
 *
 * Fails closed before any dispatch if the bound handlers do not yield exactly
 * the names the family records pin, so a factory that drifts from its record
 * surfaces when the sandbox connects rather than at the first call. The same
 * check runs for every additional caller identity, so impersonating can never
 * widen or narrow the tool surface.
 */
export function buildSandboxDispatcher(sandbox: LocalSandbox): SandboxDispatch {
  const bindings = new Map<string, Map<string, ToolHandler>>();

  function handlersFor(caller: AuthLens | undefined): Map<string, ToolHandler> {
    const key = identityKey(caller);
    const cached = bindings.get(key);
    if (cached) return cached;
    const handlers = buildSandboxHandlers(sandbox, caller);
    assertExactToolNames(
      'sandbox dispatcher tools',
      handlers.map((h) => h.name),
      SANDBOX_TOOL_NAMES,
    );
    const byName = new Map(handlers.map((h) => [h.name, h]));
    // A long-lived agent may impersonate many users; keep the map bounded and
    // never evict the default binding, which every non-impersonating call uses.
    if (bindings.size >= IDENTITY_CACHE_LIMIT) {
      for (const existing of [...bindings.keys()]) {
        if (existing !== 'app-session') bindings.delete(existing);
      }
    }
    bindings.set(key, byName);
    return byName;
  }

  // Fail closed at construction, before any identity is in play.
  handlersFor(undefined);

  return async (name, args, actAs) => {
    const handler = handlersFor(actAs).get(name);
    if (!handler) throw new UnknownToolError(name);
    // ToolContext is supplied minimally; these handlers only read the
    // signal field (and our factory handlers don't use it).
    const ctx = {
      signal: new AbortController().signal,
    } as never;
    const result = await handler.execute(args, ctx);
    return {
      ok: result.ok,
      summary: result.summary,
      data: result.data,
    };
  };
}

/**
 * Convenience: build a dispatcher and immediately invoke it. Same shape
 * `connectBridge` expects as its `dispatcher` option.
 *
 * Dispatchers are cached per sandbox so repeated bridge requests reuse the
 * same bound handler set.
 */
const sandboxDispatchers = new WeakMap<LocalSandbox, SandboxDispatch>();

export async function dispatchSandboxTool(
  sandbox: LocalSandbox,
  name: string,
  args: Record<string, unknown>,
  actAs?: AuthLens,
): Promise<DispatchResult> {
  let dispatcher = sandboxDispatchers.get(sandbox);
  if (!dispatcher) {
    dispatcher = buildSandboxDispatcher(sandbox);
    sandboxDispatchers.set(sandbox, dispatcher);
  }
  return dispatcher(name, args, actAs);
}

/**
 * Tool names this dispatcher recognises, read from the forwarded family
 * records in family order, so it equals what the page executes AND what the
 * bridge advertises. `connectBridge` sends this as the `hello.tools` payload
 * so the bridge advertises exactly the executable set.
 */
export const SANDBOX_TOOL_NAMES: readonly string[] = toolFamilies('forwarded').flatMap(
  (family) => family.tools,
);

export class UnknownToolError extends Error {
  constructor(public readonly tool: string) {
    super(`unknown sandbox tool: ${tool}`);
    this.name = 'UnknownToolError';
  }
}
