import type { ToolHandler } from '@inbrowser/agent';
import { canIUse, createCanIUseTool } from '@pyric/cli/conformance/browser';

/** Browser-facing adapter over the same generated query runtime used by the
 * CLI and MCP bridge. The Playground prompt never carries a feature list. */
export const canIUseHandler: ToolHandler = createCanIUseTool({
  description:
    'Check a Firebase feature before using it in generated app code. Returns availability, fidelity, assurance, caveats, and evidence from Pyric\'s central conformance model.',
  featureDescription: 'Exact feature name, optionally surface-qualified.',
  importPathDescription: 'Canonical import that must expose it, such as pyric/auth.',
  query: (feature, options) => canIUse(feature, options),
});
