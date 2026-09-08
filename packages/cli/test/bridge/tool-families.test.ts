/**
 * Tool family composition tests for the Typed-Service Contract Foundation.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  buildSandboxDispatcher,
  SANDBOX_TOOL_NAMES,
  UnknownToolError,
} from '../../src/bridge/client/dispatch.js';
import {
  SANDBOX_HANDLER_FACTORIES,
  type SandboxBinding,
} from '../../src/bridge/client/tool-family-factories.js';
import {
  FORWARDED_METADATA_FACTORIES,
} from '../../src/bridge/server/tool-family-factories.js';
import { getSandboxToolMetadata } from '../../src/bridge/server/tool-metadata.js';
import {
  DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  getDefaultMcpToolSurface,
} from '../../src/bridge/server/mcp-contract.js';
import { assertExactToolNames, toolFamilies, type ForwardedFamilyKey } from '../../src/bridge/tool-families.js';
import { MCP_TOOL_CONTRACTS } from '../../src/bridge/contract/index.js';

const stub = () => {
  throw new Error('stub resolver must not run');
};

describe('tool family contract composition', () => {
  it('yields exact tool names matching MCP_TOOL_CONTRACTS', () => {
    const forwardedFamilies = toolFamilies('forwarded');
    expect(forwardedFamilies.length).toBe(1);
    expect(forwardedFamilies[0].tools).toEqual(MCP_TOOL_CONTRACTS.map((c) => c.name));
  });

  it('Node metadata and Browser handler factories agree on descriptions and parameters', () => {
    const sandbox = initializeSandbox();
    const binding: SandboxBinding = { sandbox };

    for (const family of toolFamilies('forwarded')) {
      const nodeHandlers = FORWARDED_METADATA_FACTORIES[family.key as ForwardedFamilyKey](stub);
      const browserHandlers = SANDBOX_HANDLER_FACTORIES[family.key as ForwardedFamilyKey](binding);

      expect(nodeHandlers.map((h) => h.name)).toEqual(browserHandlers.map((h) => h.name));
      for (let i = 0; i < nodeHandlers.length; i++) {
        expect(nodeHandlers[i].description).toBe(browserHandlers[i].description);
        expect(nodeHandlers[i].parameters).toEqual(browserHandlers[i].parameters);
      }
    }
  });

  it('assertExactToolNames throws when tool lists drift', () => {
    expect(() =>
      assertExactToolNames('test', ['switch_auth_identity'], ['switch_auth_identity', 'manage_auth_users'])
    ).toThrow(/drifted from the default MCP contract/);
  });

  it('every advertised tool resolves in buildSandboxDispatcher and unknown tools throw UnknownToolError', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);

    expect(SANDBOX_TOOL_NAMES).toEqual(DEFAULT_MCP_FORWARDED_TOOL_NAMES);
    const surface = getDefaultMcpToolSurface();
    expect(surface.forwarded.length).toBe(12);
    expect(getSandboxToolMetadata().length).toBe(12);

    await expect(dispatch('unknown_legacy_tool', {})).rejects.toBeInstanceOf(UnknownToolError);
  });
});
