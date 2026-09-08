/**
 * Node-side factory for Typed-Service Contract tool families.
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { CallerIdentityStore, SessionRegistry } from '../../auth/identity.js';
import type { ForwardedFamilyKey } from '../tool-families.js';
import { MCP_TOOL_CONTRACTS } from '../contract/index.js';

export interface InProcessToolContext {
  scope?: unknown;
  consumers?: SessionRegistry;
  callerIdentity?: CallerIdentityStore;
}

export type StubResolver = () => never;

/** Forwarded families derived from MCP_TOOL_CONTRACTS. */
export const FORWARDED_METADATA_FACTORIES = {
  'typed-contract': (stub) =>
    MCP_TOOL_CONTRACTS.map((contract) => ({
      name: contract.name,
      description: contract.description,
      parameters: contract.jsonSchema,
      execute: stub as never,
    })),
} satisfies Record<ForwardedFamilyKey, (stub: StubResolver) => ToolHandler[]>;

/** In-process families (all 12 tools are forwarded in the unified typed contract). */
export const IN_PROCESS_HANDLER_FACTORIES: Record<
  string,
  (context?: InProcessToolContext) => ToolHandler[]
> = {};
