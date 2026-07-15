import type { ToolHandler } from '@inbrowser/agent';
import { canIUse, type FeatureSupport } from './.generated/can-i-use.js';

function resultSummary(result: FeatureSupport | FeatureSupport[]): string {
  if (Array.isArray(result)) {
    if (result.length === 0) return 'No conformance feature matched that query';
    return `Found ${result.length} deterministic conformance candidates`;
  }
  return result.summary;
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
        },
        required: ['feature'],
      },
      async execute(args) {
        const feature = (args as { feature?: unknown }).feature;
        if (typeof feature !== 'string' || feature.trim() === '') {
          return { ok: false, summary: 'pyric_can_i_use requires a non-empty feature name' };
        }
        const result = canIUse(feature);
        return { ok: true, summary: resultSummary(result), data: result };
      },
    },
  ];
}
