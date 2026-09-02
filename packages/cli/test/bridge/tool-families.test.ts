/**
 * Tool family composition: the Node side lists tool metadata over MCP, the
 * browser side executes handlers, and the default contract pins the names.
 * These tests pin the three properties that hold by construction today and
 * must survive any change in how the families are composed:
 *
 *  1. The listed order equals the pinned contract order, per transport.
 *  2. Every name the browser peer advertises resolves in its dispatcher.
 *  3. The metadata the Node side advertises (description and parameters)
 *     equals the metadata of the handlers the browser executes, per tool.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createFirestoreSimulatorTools } from 'pyric/rules/internal';
import { createFirestoreDataTools, createFirestoreInspectTools } from 'pyric/firestore';
import { createRtdbInspectionTools } from '../../src/rtdb/inspection.js';
import {
  buildSandboxDispatcher,
  SANDBOX_TOOL_NAMES,
  UnknownToolError,
} from '../../src/bridge/client/dispatch.js';
import { getSandboxToolMetadata } from '../../src/bridge/server/tool-metadata.js';
import {
  DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
  getDefaultMcpToolSurface,
} from '../../src/bridge/server/mcp-contract.js';

describe('tool family composition', () => {
  it('lists forwarded and in-process tools in the pinned contract order', () => {
    const surface = getDefaultMcpToolSurface();
    expect(surface.forwarded.map((tool) => tool.name)).toEqual([
      ...DEFAULT_MCP_FORWARDED_TOOL_NAMES,
    ]);
    expect(surface.inProcess.map((tool) => tool.name)).toEqual([
      ...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
    ]);
  });

  it('resolves every advertised sandbox tool name in the browser dispatcher', async () => {
    const dispatch = buildSandboxDispatcher(initializeSandbox());
    for (const name of SANDBOX_TOOL_NAMES) {
      try {
        await dispatch(name, {});
      } catch (error) {
        expect(error).not.toBeInstanceOf(UnknownToolError);
      }
    }
    await expect(dispatch('not_a_tool', {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it('advertises the same description and parameters the browser executes', () => {
    const stub = () => {
      throw new Error('stub resolver must not run');
    };
    const executed = new Map(
      [
        ...createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
        ...createFirestoreDataTools({ resolveDb: stub as never }),
        ...createFirestoreInspectTools({ resolveSandbox: stub as never }),
        ...createRtdbInspectionTools({ resolveSandbox: stub as never }),
      ].map((handler) => [handler.name, handler]),
    );
    const advertised = getSandboxToolMetadata();
    expect(advertised.map((tool) => tool.name)).toEqual([...executed.keys()]);
    for (const tool of advertised) {
      const handler = executed.get(tool.name)!;
      expect(tool.description).toBe(handler.description);
      expect(tool.parameters).toEqual(handler.parameters as Record<string, unknown>);
    }
  });
});
