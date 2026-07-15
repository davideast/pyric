/**
 * Browser-side tool dispatcher. Consumes the SAME tool factories the
 * bridge advertises over MCP (`getSandboxToolMetadata`), so the set the
 * bridge LISTS and the set the page EXECUTES are identical. There is one
 * source of truth: the factories in `buildSandboxHandlers`.
 *
 * History of the trap this guards against: earlier this file delegated
 * to ONLY `createFirestoreSimulatorTools`, while `getSandboxToolMetadata`
 * advertised the simulator + data-plane + inspect families. The bridge
 * therefore LISTED `firestore_create_document` / `sandbox_inspect`
 * etc., but a `callTool` failed at dispatch with "tool 'X' is not
 * registered with the connected sandbox peer" — succeed-at-list,
 * fail-at-dispatch. Registering every family here (and deriving
 * `SANDBOX_TOOL_NAMES` from the same set) closes the gap. The parity is
 * pinned by `test/bridge/tool-parity.test.ts`.
 */

import { createFirestoreSimulatorTools } from 'pyric/rules/internal/node';
import {
  createFirestoreDataTools,
  createFirestoreInspectTools,
  getFirestore,
  getAdminFirestore,
  type As,
} from 'pyric/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';

export interface DispatchResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/**
 * The full handler set for a sandbox: the simulator family (bound to the
 * internal env) plus the modular data-plane and inspect families (bound
 * to a per-call `resolveDb`). This is the single source of truth shared
 * by `buildSandboxDispatcher` and `SANDBOX_TOOL_NAMES`, and it MUST stay
 * aligned with `getSandboxToolMetadata` (asserted by tool-parity.test.ts).
 *
 * Auth: `resolveDb('admin')` / `resolveDb(undefined)` is an admin-bypass handle
 * (no rules); `resolveDb({ uid, claims })` is a rules-enforcing client acting as
 * that user — `claims` ride the auth token, matching the rules
 * `request.auth.token` shape. This is a SANDBOX dispatcher, so the admin default
 * is intended; a dispatcher wired to a real backend must reject `'admin'`.
 */
function buildSandboxHandlers(sandbox: LocalSandbox) {
  const env = getInternalEnv(sandbox);
  const resolveDb = (actor?: As) =>
    actor && actor !== 'admin'
      ? getFirestore(sandbox.withAuth({ uid: actor.uid, token: actor.claims }))
      : getAdminFirestore(sandbox);
  return [
    ...createFirestoreSimulatorTools({ resolveSandbox: () => env }),
    ...createFirestoreDataTools({ resolveDb }),
    ...createFirestoreInspectTools({ resolveSandbox: () => sandbox }),
    ...createRtdbInspectionTools({ resolveSandbox: () => sandbox }),
  ];
}

/**
 * Build a dispatcher for the supplied `Sandbox`. The returned function
 * looks up tools by name across every factory and invokes the
 * canonical handler. Throws `UnknownToolError` on unknown names.
 */
export function buildSandboxDispatcher(
  sandbox: LocalSandbox,
): (name: string, args: Record<string, unknown>) => Promise<DispatchResult> {
  const byName = new Map(buildSandboxHandlers(sandbox).map((h) => [h.name, h]));
  return async (name, args) => {
    const handler = byName.get(name);
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
const sandboxDispatchers = new WeakMap<
  LocalSandbox,
  ReturnType<typeof buildSandboxDispatcher>
>();

export async function dispatchSandboxTool(
  sandbox: LocalSandbox,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  let dispatcher = sandboxDispatchers.get(sandbox);
  if (!dispatcher) {
    dispatcher = buildSandboxDispatcher(sandbox);
    sandboxDispatchers.set(sandbox, dispatcher);
  }
  return dispatcher(name, args);
}

/**
 * Tool names this dispatcher recognises, derived at load time from the
 * SAME factories — so it equals what the page executes AND what the
 * bridge advertises. `connectBridge` sends this as the `hello.tools`
 * payload so the bridge advertises exactly the executable set.
 */
export const SANDBOX_TOOL_NAMES: string[] = (() => {
  const stub = async () => {
    throw new Error('SANDBOX_TOOL_NAMES: stub resolver should never be invoked');
  };
  return [
    ...createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
    ...createFirestoreDataTools({ resolveDb: stub as never }),
    ...createFirestoreInspectTools({ resolveSandbox: stub as never }),
    ...createRtdbInspectionTools({ resolveSandbox: stub as never }),
  ].map((h) => h.name);
})();

export class UnknownToolError extends Error {
  constructor(public readonly tool: string) {
    super(`unknown sandbox tool: ${tool}`);
    this.name = 'UnknownToolError';
  }
}
