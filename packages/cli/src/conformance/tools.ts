import type { ToolHandler } from '@inbrowser/agent';
import { createCanIUseTool } from './can-i-use-tool.js';
import { CONFORMANCE_SUPPORTS, resolveCanIUse, type FeatureSupport } from './.generated/can-i-use.js';

/** Node-only conformance tools. The richer model never enters a browser bundle. */
export function createConformanceTools(): ToolHandler[] {
  return [
    createCanIUseTool({
      description:
        'Check whether Pyric can support a developer-facing Firebase feature. Reports availability, behavior fidelity, and assurance eligibility separately, with caveats and auditable claims. Exact names resolve first; fuzzy names return deterministic candidates.',
      featureDescription: 'Developer feature name, optionally prefixed by a surface (for example firestore-rules/getAfter).',
      importPathDescription: 'Optional published import path that must expose the feature (for example pyric/storage).',
      query: (feature, options) => resolveCanIUse<FeatureSupport>(CONFORMANCE_SUPPORTS, feature, options),
    }),
  ];
}
