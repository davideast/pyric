import type { ToolHandler } from '@inbrowser/agent';
import { canIUse } from '@pyric/cli/conformance/browser';

/** Browser-facing adapter over the same generated query runtime used by the
 * CLI and MCP bridge. The Playground prompt never carries a feature list. */
export const canIUseHandler: ToolHandler = {
  name: 'pyric_can_i_use',
  description:
    'Check a Firebase feature before using it in generated app code. Returns availability, fidelity, assurance, caveats, and evidence from Pyric\'s central conformance model.',
  parameters: {
    type: 'object',
    properties: {
      feature: { type: 'string', description: 'Exact feature name, optionally surface-qualified.' },
      importPath: { type: 'string', description: 'Canonical import that must expose it, such as pyric/auth.' },
    },
    required: ['feature'],
  },
  async execute(args) {
    const { feature, importPath } = args as { feature?: unknown; importPath?: unknown };
    if (typeof feature !== 'string' || feature.trim() === '') {
      return { ok: false, summary: 'pyric_can_i_use requires a non-empty feature name' };
    }
    if (importPath !== undefined && (typeof importPath !== 'string' || importPath.trim() === '')) {
      return { ok: false, summary: 'pyric_can_i_use importPath must be a non-empty string when provided' };
    }
    const result = canIUse(feature, {
      importPath: typeof importPath === 'string' ? importPath : undefined,
    });
    return {
      ok: result.match === 'exact',
      summary: result.match === 'exact'
        ? result.supports[0]!.summary
        : `Conformance query returned ${result.match}`,
      data: result,
    };
  },
};
