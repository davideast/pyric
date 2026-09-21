import type { ToolHandler } from '@inbrowser/agent';
import { createCanIUseTool } from './can-i-use-tool.js';
import { canIUse } from './can-i-use.js';

/** Node-only conformance tools. The richer model never enters a browser bundle. */
export function createConformanceTools(): ToolHandler[] {
  return [
    createCanIUseTool({
      description:
        'Check whether Pyric can support a developer-facing Firebase feature. Reports engine availability, behavior fidelity, and assurance eligibility separately. The served field describes Node-hosted and SharedWorker runtime availability: supported APIs run, imports-only APIs throw when called, and missing APIs cannot be imported. Exact names resolve first; fuzzy names return deterministic candidates.',
      featureDescription: 'Developer feature name, optionally prefixed by a surface (for example firestore-rules/getAfter).',
      importPathDescription: 'Optional import path: pyric/storage queries the engine; firebase/storage queries the served entry. All seven Firebase module paths are supported.',
      query: canIUse,
    }),
  ];
}
