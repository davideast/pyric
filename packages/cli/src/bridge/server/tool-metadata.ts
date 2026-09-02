/**
 * Node-side composition of the tool families the bridge serves over MCP.
 *
 * Forwarded families are executed by the browser sandbox peer, so this
 * process never holds a `LocalEnvironment`. It still needs each tool's
 * metadata (name, description, parameters) to populate the MCP tool list, so
 * it calls the family factories with a stub resolver and reads only the
 * metadata; the bridge replaces `execute` with forward-to-peer dispatch
 * before any call reaches a handler.
 *
 * In-process families run here without a browser peer and are returned as
 * live handlers.
 *
 * Family order comes from the records under `../tool-family-records/`; the
 * factories come from `./tool-family-factories.ts`.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { toolFamilies } from '../tool-families.js';
import {
  FORWARDED_METADATA_FACTORIES,
  IN_PROCESS_HANDLER_FACTORIES,
  type StubResolver,
} from './tool-family-factories.js';

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
 * Tool metadata for every forwarded family, in family order. The stub
 * resolver never runs: the bridge replaces `execute()` with its own
 * forward-to-peer dispatch.
 */
export function getSandboxToolMetadata(): ToolMetadata[] {
  const stub: StubResolver = () => {
    throw new Error(
      'BUG: sandbox-tool factory executor invoked on the bridge side — should have been replaced',
    );
  };
  return toolFamilies('forwarded')
    .flatMap((family) => FORWARDED_METADATA_FACTORIES[family.key](stub))
    .map(toMetadata);
}

/**
 * Live handlers for every in-process family, in family order. The bridge
 * registers each handler's `execute` directly.
 *
 * `scope` is forwarded so the hosted Rules Test API verification tool can
 * authenticate without changing the bridge's sandbox-only execution model.
 */
export function getInProcessToolHandlers(scope?: unknown): ToolHandler[] {
  return toolFamilies('in-process').flatMap((family) =>
    IN_PROCESS_HANDLER_FACTORIES[family.key](scope),
  );
}
