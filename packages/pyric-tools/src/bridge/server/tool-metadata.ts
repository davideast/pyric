/**
 * Extract tool metadata (name + description + parameters) from the
 * existing `pyric/rules` factories without running any
 * tool logic. Used by the bridge to register MCP tools whose actual
 * dispatch happens against the connected browser peer.
 *
 * Why: `createFirestoreSimulatorTools` returns `ToolHandler[]` with
 * `execute` bound to a `LocalEnvironment`. The bridge process doesn't
 * have a `LocalEnvironment` — it forwards. But it does need the
 * metadata to populate the MCP server's tool list. This module calls
 * the factory with a stub resolver and reads only the metadata; the
 * stub never gets invoked because the bridge replaces `execute`
 * before dispatch.
 */

import type { ToolHandler } from '@inbrowser/agent';
import {
  createFirestoreSimulatorTools,
  createFirestoreRulesTools,
} from 'pyric/rules/node';
import { createFirestoreDataTools, createFirestoreInspectTools } from 'pyric/firestore';

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function toMetadata(handler: ToolHandler): ToolMetadata {
  return {
    name: handler.name,
    description: handler.description,
    parameters: handler.parameters as Record<string, unknown>,
  };
}

/**
 * Tool metadata for the sandbox-mode bridge. Includes the
 * data-plane / sandbox-management tools that the browser dispatches
 * via `LocalEnvironment`. Rules tooling (lint, validate, simulate,
 * test) is NOT included here — those execute in Node and are
 * registered separately, since they don't need the browser sandbox.
 */
export function getSandboxToolMetadata(): ToolMetadata[] {
  // The resolver stub never runs: the bridge replaces execute() with
  // its own forward-to-peer dispatch.
  const stubResolver = async () => {
    throw new Error(
      'BUG: sandbox-tool factory executor invoked on the bridge side — should have been replaced',
    );
  };
  const handlers: ToolHandler[] = [
    // Simulator / write / batch / undo / redo / events / transaction —
    // 8 tools that mutate or read the in-browser sandbox state.
    ...createFirestoreSimulatorTools({
      resolveSandbox: stubResolver as never,
    }),
    // Data plane — addDoc / setDoc / getDoc / updateDoc / deleteDoc /
    // collection / query / where — the modular Firestore CRUD surface
    // routed through the browser sandbox so agents can drive a real app
    // session rather than only the simulator.
    ...createFirestoreDataTools({
      resolveDb: stubResolver as never,
    }),
    // `sandbox_inspect` — single-call diagnostic that answers
    // "what state is the sandbox in?" Born out of CLAUDE_DEBUG_SESSION.md
    // (a real agent needing 51 tool calls + 72k tokens to figure out
    // that rules weren't loaded). Routes to the browser sandbox like
    // the other forwarded tools.
    ...createFirestoreInspectTools({
      resolveDb: stubResolver as never,
    }),
  ];
  return handlers.map(toMetadata);
}

/**
 * Rules tooling factories that execute in-process on the bridge
 * (no browser needed). Returned as live ToolHandlers — the bridge
 * registers each handler's `execute` directly.
 *
 * `scope` is forwarded to the factory so deploy-gated tools that
 * need a `ProjectScope` work in prod-mode bridges too.
 */
export function getRulesToolHandlers(scope?: unknown): ToolHandler[] {
  // Factory accepts { scope } per packages/pyric/src/rules/tools.ts.
  // The cast is because pyric/rules's ProjectScope type is re-exported
  // from pyric-tools/deploy and we'd otherwise force a type-only import
  // here. Bridge level we don't need the type.
  // Includes simulate / lint / resolve_modules / stdlib_list /
  // stdlib_get + (when scope is supplied) extract + deploy gates —
  // the full in-process rules tooling surface. No browser needed.
  return createFirestoreRulesTools({ scope } as never);
}
