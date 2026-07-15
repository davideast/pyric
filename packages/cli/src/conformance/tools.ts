import type { ToolHandler } from '@inbrowser/agent';
import { CONFORMANCE_SUPPORTS, resolveCanIUse, type CanIUseResult, type FeatureSupport } from './.generated/can-i-use.js';

function resultSummary(result: CanIUseResult<FeatureSupport>): string {
  if (result.match === 'none') return 'No conformance feature matched that query';
  if (result.match === 'suggestions') return `No exact match; found ${result.supports.length} deterministic suggestions`;
  if (result.match === 'ambiguous') return `Found ${result.supports.length} exact matches across surfaces`;
  return result.supports[0]!.summary;
}

/** Node-only conformance tools. The richer model never enters a browser bundle. */
export function createConformanceTools(): ToolHandler[] {
  return [
    {
      name: 'pyric_can_i_use',
      description:
        'Check whether Pyric can support a developer-facing Firebase feature. Reports availability, behavior fidelity, and assurance eligibility separately, with caveats and auditable claims. Exact names resolve first; fuzzy names return deterministic candidates.',
      parameters: {
        type: 'object',
        properties: {
          feature: {
            type: 'string',
            description: 'Developer feature name, optionally prefixed by a surface (for example firestore-rules/getAfter).',
          },
          importPath: {
            type: 'string',
            description: 'Optional published import path that must expose the feature (for example pyric/storage).',
          },
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
        const result = resolveCanIUse<FeatureSupport>(CONFORMANCE_SUPPORTS, feature, {
          importPath: typeof importPath === 'string' ? importPath : undefined,
        });
        return { ok: result.match === 'exact', summary: resultSummary(result), data: result };
      },
    },
  ];
}
