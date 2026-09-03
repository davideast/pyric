/**
 * In-process ("local") Bridge for the headless MCP server.
 *
 * The serve / standalone bridges forward data-plane tool calls over a WebSocket
 * to the in-page sandbox. The headless server has no page: the sandbox runs IN
 * this process, so the bridge's `dispatch` executes tools directly through
 * `buildSandboxDispatcher`. Everything else the `Bridge` contract needs is
 * trivial for a peerless bridge (always "connected", with the operation set
 * from the dispatcher's `SANDBOX_OP_KEYS`).
 *
 * Because `buildSandboxDispatcher` is the SAME source the served bridge
 * advertises (pinned by `tool-parity.test.ts`), the headless tool surface is
 * identical to the served one, including the per-identity `as` arg.
 *
 * See design rationale (headless mode).
 */
import type { LocalSandbox } from 'pyric/sandbox';
import { buildSandboxDispatcher, SANDBOX_OP_KEYS } from '../client/dispatch.js';
import { createBridge, type Bridge } from './bridge.js';
import { pyricVersion } from '../../serve/standalone-assets.js';

export interface LocalBridgeOptions {
  /** Reported as the MCP server version. */
  version?: string;
  /** Project label surfaced in tool-result metadata. */
  project?: string;
  /** Called after each dispatch (success or failure). The headless runner uses
   *  this to schedule a debounced persistence flush so writes survive a restart. */
  onAfterDispatch?: () => void;
}

/**
 * A {@link Bridge} backed by an in-process {@link Sandbox}. `dispatch` runs tools
 * locally; the peer-management members are no-ops (there is no remote peer).
 */
export function createLocalBridge(sandbox: LocalSandbox, opts: LocalBridgeOptions = {}): Bridge {
  const dispatcher = buildSandboxDispatcher(sandbox);
  // Reuse the real bridge for the boilerplate the contract needs (startedAt,
  // instanceId, health, recordToolEvent, the peer machinery), then override the
  // three members that differ when the sandbox is in-process rather than a ws
  // peer. The peer machinery stays idle because `dispatch` never touches it.
  const base = createBridge({
    project: opts.project ?? 'sandbox',
    version: opts.version ?? pyricVersion(),
  });
  return {
    ...base,
    // The sandbox is in-process: always "connected", and the operation set is
    // the dispatcher's, not a (nonexistent) peer's hello.
    isSandboxConnected: () => true,
    opKeys: () => [...SANDBOX_OP_KEYS],
    // Execute tools locally instead of forwarding to a ws peer. The bridge
    // contract RETURNS a result (ok:false on failure) rather than rejecting, and
    // `buildSandboxDispatcher` throws on a tool error (e.g. a rules denial), so
    // translate that here.
    async dispatch(tool, op, args) {
      try {
        return await dispatcher(tool, op, args);
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) };
      } finally {
        opts.onAfterDispatch?.();
      }
    },
  };
}
