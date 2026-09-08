/**
 * Browser/Sandbox factory for the Typed-Service Contract tools.
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { AuthLens, LocalSandbox } from 'pyric/sandbox';
import type { ForwardedFamilyKey } from '../tool-families.js';
import { MCP_TOOL_CONTRACTS } from '../contract/index.js';

export interface SandboxBinding {
  sandbox: LocalSandbox;
  caller?: AuthLens;
}

export const SANDBOX_HANDLER_FACTORIES = {
  'typed-contract': (binding) =>
    MCP_TOOL_CONTRACTS.map((contract) => ({
      name: contract.name,
      description: contract.description,
      parameters: contract.jsonSchema,
      execute: async (args: Record<string, unknown>) => {
        const res = (await contract.execute(args as never, {
          sandbox: binding.sandbox,
          caller: binding.caller,
        })) as Record<string, unknown> | undefined;

        const ok = res && typeof res === 'object' && 'ok' in res ? Boolean(res.ok) : true;
        const errorMsg =
          res && typeof res === 'object' && 'error' in res && typeof res.error === 'string'
            ? res.error
            : undefined;
        const summary = errorMsg ?? JSON.stringify(res ?? {});

        return {
          ok,
          summary,
          data: res,
        };
      },
    })),
} satisfies Record<ForwardedFamilyKey, (binding: SandboxBinding) => ToolHandler[]>;
