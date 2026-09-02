/**
 * Browser-side tool dispatcher. Resolves every forwarded `(tool, op)` from
 * the same records the bridge advertises over MCP (`composeMcpTools`), so the
 * set the bridge LISTS and the set the page EXECUTES are identical by
 * construction: the records under `../tool-records/` pin the operations, and
 * `./tool-factories.ts` supplies one browser-safe factory per factory key.
 *
 * History of the trap this guards against: earlier this file delegated to
 * ONLY the simulator factory, while the bridge advertised the simulator,
 * data-plane and inspect families. The bridge therefore LISTED operations a
 * `callTool` failed to dispatch with "not registered with the connected
 * sandbox peer" (succeed-at-list, fail-at-dispatch). Composing every
 * operation from the records, and deriving `SANDBOX_OP_KEYS` from the same
 * records, closes the gap. The parity is pinned by
 * `test/bridge/tool-parity.test.ts` and `test/bridge/tool-records.test.ts`.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { getFirestore, getAdminFirestore, type As } from 'pyric/firestore';
import { getDatabase, getAdminDatabase, type DatabaseAs } from 'pyric/database';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import {
  assertExactOpKeys,
  bindOpArgs,
  opKey,
  resolveOpHandlers,
  toolOps,
  type ToolOp,
} from '../tool-records.js';
import { SANDBOX_FACTORIES, type SandboxBinding } from './tool-factories.js';

export interface DispatchResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export type SandboxDispatcher = (
  tool: string,
  op: string,
  args: Record<string, unknown>,
) => Promise<DispatchResult>;

/**
 * The handler behind every forwarded operation for a sandbox, keyed by
 * `tool.op`, each factory bound to one `SandboxBinding` built here.
 *
 * Auth: `resolveDb('admin')` / `resolveDb(undefined)` is an admin-bypass handle
 * (no rules); `resolveDb({ uid, claims })` is a rules-enforcing client acting as
 * that user — `claims` ride the auth token, matching the rules
 * `request.auth.token` shape. This is a SANDBOX dispatcher, so the admin default
 * is intended; a dispatcher wired to a real backend must reject `'admin'`.
 */
function buildSandboxHandlers(
  sandbox: LocalSandbox,
): Map<string, { spec: ToolOp; handler: ToolHandler }> {
  const binding: SandboxBinding = {
    sandbox,
    env: getInternalEnv(sandbox),
    resolveDb: (actor?: As) =>
      actor && actor !== 'admin'
        ? getFirestore(sandbox.withAuth({ uid: actor.uid, token: actor.claims }))
        : getAdminFirestore(sandbox),
    resolveDatabase: (actor?: DatabaseAs) =>
      actor && actor !== 'admin'
        ? getDatabase(sandbox.withAuth({ uid: actor.uid, token: actor.claims }))
        : getAdminDatabase(sandbox),
  };
  return resolveOpHandlers(toolOps('forwarded'), (spec) =>
    SANDBOX_FACTORIES[spec.factory as keyof typeof SANDBOX_FACTORIES](binding),
  );
}

/**
 * Build a dispatcher for the supplied `Sandbox`. The returned function
 * resolves `(tool, op)` across every forwarded operation and invokes the
 * canonical handler with the record's pinned fields applied. Throws
 * `UnknownToolError` on an unknown pair.
 *
 * Fails closed before any dispatch if the bound handlers do not yield exactly
 * the operations the records pin, so a factory that drifts from its record
 * surfaces when the sandbox connects rather than at the first call.
 */
export function buildSandboxDispatcher(sandbox: LocalSandbox): SandboxDispatcher {
  const handlers = buildSandboxHandlers(sandbox);
  assertExactOpKeys('sandbox dispatcher operations', [...handlers.keys()], SANDBOX_OP_KEYS);
  return async (tool, op, args) => {
    const entry = handlers.get(opKey(tool, op));
    if (!entry) throw new UnknownToolError(tool, op);
    // ToolContext is supplied minimally; these handlers only read the
    // signal field (and our factory handlers don't use it).
    const ctx = {
      signal: new AbortController().signal,
    } as never;
    const result = await entry.handler.execute(bindOpArgs(entry.spec, args), ctx);
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
const sandboxDispatchers = new WeakMap<LocalSandbox, SandboxDispatcher>();

export async function dispatchSandboxTool(
  sandbox: LocalSandbox,
  tool: string,
  op: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  let dispatcher = sandboxDispatchers.get(sandbox);
  if (!dispatcher) {
    dispatcher = buildSandboxDispatcher(sandbox);
    sandboxDispatchers.set(sandbox, dispatcher);
  }
  return dispatcher(tool, op, args);
}

/**
 * `tool.op` keys this dispatcher recognises, read from the forwarded
 * operations of the records in record order, so it equals what the page
 * executes AND what the bridge advertises. `connectBridge` sends this as the
 * `hello.tools` payload so the bridge forwards exactly the executable set.
 */
export const SANDBOX_OP_KEYS: readonly string[] = toolOps('forwarded').map((op) =>
  opKey(op.tool, op.op),
);

export class UnknownToolError extends Error {
  constructor(
    public readonly tool: string,
    public readonly op: string,
  ) {
    super(`unknown sandbox tool operation: ${tool}.${op}`);
    this.name = 'UnknownToolError';
  }
}
