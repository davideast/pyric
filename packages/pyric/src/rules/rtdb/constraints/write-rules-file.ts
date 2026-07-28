/**
 * Node-only convenience for writing a compiled RTDB rules document to a
 * static `database.rules.json` file.
 *
 * Deliberately kept out of `document.ts` (and out of the browser-facing
 * `pyric/rules` and `pyric/database` root entries) — it imports
 * `node:fs` / `node:path`, so it lives alongside the other Node-only
 * surfaces re-exported from `pyric/rules/internal/node`. It does no compilation
 * of its own: it calls `doc.toJSON()`, which routes through
 * the pure RTDB rules serializer, then writes the result.
 *
 * Uses the SYNC `node:fs` / `node:path` specifiers (not `node:fs/promises`)
 * to match the module resolver's existing Node-builtin usage — `pyric/rules`
 * is statically reachable from Studio's browser bundle (a known wart, see
 * `modules/resolver.ts` and `@pyric/cli/vite`'s `NODE_BUILTIN_SHIMS`), and
 * those shims only cover the bare `fs`/`path`/`url` specifiers.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { RtdbRulesDocumentInternal } from './document.js';

/**
 * Write `doc.toJSON()` to `path` as pretty-printed JSON, creating parent
 * directories as needed. Returns the resolved absolute path written.
 */
export async function writeRtdbRulesFile(
  doc: RtdbRulesDocumentInternal,
  path: string,
): Promise<string> {
  const resolved = resolvePath(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(doc.toJSON(), null, 2)}\n`, 'utf-8');
  return resolved;
}
