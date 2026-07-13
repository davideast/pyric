/**
 * Loads a user's RTDB constraints module (a file that calls
 * `defineRtdbRules(...)` from `pyric/rules`) so the CLI and MCP
 * `generate` surfaces can turn it into static rules JSON without
 * reimplementing compilation — the loaded document's `.toJSON()` still
 * routes through the pure RTDB rules compiler.
 *
 * The module may export the `RtdbRulesDocument` as its default export
 * or as a named `rules` export.
 */

import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import type { RtdbRulesDocument } from 'pyric/rules/internal/rtdb';
import { isRtdbRulesDocument } from './rules-json.js';

export interface LoadRtdbRulesDocumentOptions {
  cwd?: string;
  /** Named export to look for before falling back to `default`. Defaults to `rules`. */
  exportName?: string;
}

export type LoadRtdbRulesDocumentResult =
  | { ok: true; document: RtdbRulesDocument }
  | { ok: false; message: string };

export async function loadRtdbRulesDocument(
  configPath: string,
  options: LoadRtdbRulesDocumentOptions = {},
): Promise<LoadRtdbRulesDocumentResult> {
  const cwd = options.cwd ?? process.cwd();
  const exportName = options.exportName ?? 'rules';
  const resolved = resolvePath(cwd, configPath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      message: `failed to load RTDB constraints module at ${resolved}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const candidate = mod[exportName] ?? mod.default;
  if (!isRtdbRulesDocument(candidate)) {
    return {
      ok: false,
      message:
        `${resolved} does not export an RtdbRulesDocument (looked for a named ` +
        `'${exportName}' export or a default export produced by defineRtdbRules(...)).`,
    };
  }

  return { ok: true, document: candidate };
}
