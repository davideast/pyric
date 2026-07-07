/**
 * Diagnostic prompt-block manifest. Each entry is a self-contained
 * piece of pyric-supplied context the agent receives WHEN
 * `useSettingsStore.pyricDiagnosticsEnabled` is true. Toggle off and
 * `buildSystemPrompt` drops every block in this list from the prompt.
 *
 * Add a new prompt-side diagnostic: create a file in this folder
 * that exports a `PromptBlock`, then add it to the array below.
 *
 * Distinct from the registered-tool side (`~/lib/tools/diagnostics/`):
 *   - Prompt blocks: text the agent reads each turn, embedded in the
 *     system prompt by `buildSystemPrompt`. Cheap (no tool call).
 *   - Registered tools: callable handlers the agent dispatches via
 *     the registry. Costlier (round-trip) but lets the agent fetch
 *     diagnostics on demand.
 */
import { denialsBlock } from './denials-block';
import { lintBlock } from './lint-block';
import { pitfallsBlock } from './pitfalls-block';
import { playbookBlock } from './playbook-block';
import { trafficBlock } from './traffic-block';

export interface PromptBlock {
  /** Stable header label rendered between `── … ──` fences. */
  heading: string;
  /** Body text. Return null to omit the whole block (e.g. when
   *  there are no denials and the block has nothing to add). */
  render: () => string | null;
}

export const DIAGNOSTIC_BLOCKS: readonly PromptBlock[] = [
  lintBlock,
  denialsBlock,
  trafficBlock,
  pitfallsBlock,
  playbookBlock,
];

export { makeDiagnosticsContext } from './context';
