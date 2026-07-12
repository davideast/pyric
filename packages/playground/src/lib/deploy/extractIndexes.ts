/**
 * Static-analyze the workspace `appSource` for composite-index
 * requirements. Pure async function — no React, no store access.
 * Used by `useIndexesDeploy` for the per-track button and by
 * `useDeployAll` for the orchestrating button.
 *
 * Calls `extractIndexes` from `@pyric/firestore-rules` directly —
 * the static AST pass is browser-safe, no tool-handler envelope
 * needed for direct programmatic callers.
 */
import type { IndexesConfigEntry } from '@pyric/cli/deploy';
import { extractIndexes } from 'pyric/rules/internal/extract';

export async function extractIndexesFromAppSource(
  appSource: string,
): Promise<IndexesConfigEntry[]> {
  const result = extractIndexes({
    files: [{ name: 'app-source.tsx', source: appSource }],
  });
  if (!result.success) {
    throw new Error(result.error.message ?? 'extract failed');
  }
  return result.data.config.indexes;
}
