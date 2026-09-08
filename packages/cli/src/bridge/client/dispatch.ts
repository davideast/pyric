/**
 * Browser-side and local-node tool & resource dispatcher backed by the Typed-Service Contract Foundation.
 */

import type { ToolHandler } from '@inbrowser/agent';
import type { AuthLens, LocalSandbox } from 'pyric/sandbox';
import { assertExactToolNames, toolFamilies, type ForwardedFamilyKey } from '../tool-families.js';
import { SANDBOX_HANDLER_FACTORIES, type SandboxBinding } from './tool-family-factories.js';
import { MCP_RESOURCE_CONTRACTS } from '../contract/index.js';

export interface DispatchResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Dispatch one tool or resource by name, optionally under a caller identity. */
export type SandboxDispatch = (
  name: string,
  args: Record<string, unknown>,
  actAs?: AuthLens
) => Promise<DispatchResult>;

function buildSandboxHandlers(sandbox: LocalSandbox, caller?: AuthLens): ToolHandler[] {
  const binding: SandboxBinding = {
    sandbox,
    caller,
  };
  return toolFamilies('forwarded').flatMap((family) =>
    SANDBOX_HANDLER_FACTORIES[family.key as ForwardedFamilyKey](binding)
  );
}

/** Cache key for one caller identity. Distinct lenses never share a binding. */
function identityKey(caller: AuthLens | undefined): string {
  if (caller === undefined || caller.mode === 'app-session') return 'app-session';
  if (caller.mode === 'admin' || caller.mode === 'anon') return caller.mode;
  return JSON.stringify([caller.uid, caller.tenant ?? null, caller.token ?? null]);
}

const IDENTITY_CACHE_LIMIT = 16;

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
      SANDBOX_TOOL_NAMES
    );
    const byName = new Map(handlers.map((h) => [h.name, h]));
    if (bindings.size >= IDENTITY_CACHE_LIMIT) {
      for (const existing of [...bindings.keys()]) {
        if (existing !== 'app-session') bindings.delete(existing);
      }
    }
    bindings.set(key, byName);
    return byName;
  }

  handlersFor(undefined);

  return async (name, args, actAs) => {
    // Support Dual-Plane MCP resource reads via 'resources/read' or '__pyric_resource_read__'
    if (name === 'resources/read' || name === '__pyric_resource_read__') {
      const uriStr = typeof args.uri === 'string' ? args.uri : '';
      if (!uriStr) {
        return { ok: false, summary: 'Missing uri parameter for resource read' };
      }
      try {
        const parsedUrl = new URL(uriStr);
        const reader =
          MCP_RESOURCE_CONTRACTS.find((c) => {
            const prefix = c.uriTemplate.split('{')[0]!;
            return uriStr.startsWith(prefix);
          }) ?? MCP_RESOURCE_CONTRACTS[0];
        const data = await reader.read(parsedUrl, {}, { sandbox, caller: actAs });
        return {
          ok: true,
          summary: JSON.stringify(data),
          data,
        };
      } catch (err) {
        return {
          ok: false,
          summary: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const handler = handlersFor(actAs).get(name);
    if (!handler) throw new UnknownToolError(name);
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

const sandboxDispatchers = new WeakMap<LocalSandbox, SandboxDispatch>();

export async function dispatchSandboxTool(
  sandbox: LocalSandbox,
  name: string,
  args: Record<string, unknown>,
  actAs?: AuthLens
): Promise<DispatchResult> {
  let dispatcher = sandboxDispatchers.get(sandbox);
  if (!dispatcher) {
    dispatcher = buildSandboxDispatcher(sandbox);
    sandboxDispatchers.set(sandbox, dispatcher);
  }
  return dispatcher(name, args, actAs);
}

export const SANDBOX_TOOL_NAMES: readonly string[] = toolFamilies('forwarded').flatMap(
  (family) => family.tools
);

export class UnknownToolError extends Error {
  constructor(public readonly tool: string) {
    super(`unknown sandbox tool: ${tool}`);
    this.name = 'UnknownToolError';
  }
}
