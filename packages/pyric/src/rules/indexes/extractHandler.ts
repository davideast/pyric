/**
 * Handler for `firestore_extract_indexes` — Layer 1 of the indexes
 * pipeline. Statically analyzes JS/TS source for the modular Firestore
 * client API's `query(collection(...), where(...), orderBy(...))`
 * pattern and emits a `firestore.indexes.json`-shaped config plus
 * over-shoot signals + diagnostics.
 *
 * The handler is a thin shell over `extractIndexes` from
 * `./extract/extractor.ts`:
 *   - If callers pass `paths`, read them from disk into the
 *     `{ name, source }` shape the extractor expects.
 *   - If callers pass `files` directly (already-loaded source), forward
 *     them as-is.
 *
 * Unlike the deploy handler this needs no `AgentApp` — extraction is a
 * pure local AST walk with no network or auth surface.
 *
 * BROWSER-CLEAN: no static node imports. The `paths` option (disk reads)
 * acquires `node:fs`/`node:path` lazily via `process.getBuiltinModule` —
 * no import statement exists for a bundler to chase, so this module (which
 * the `pyric/rules` index exports, reachable from browser graphs) bundles
 * clean. In a browser, `paths` returns a clear EXTRACT_FAILED instead;
 * `files` (pre-loaded source — the browser shape) is unaffected.
 */
import { extractIndexes } from './extract/extractor.js';
import type { ExtractResult } from './extract/types.js';

/** Lazily acquire the node builtins the `paths` branch needs. Returns null
 *  outside node (or on node <20.16, which predates getBuiltinModule). */
function nodeFsPath(): { readFileSync: (p: string, enc: 'utf-8') => string; resolve: (p: string) => string } | null {
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(process, 'node:fs') as { readFileSync: (p: string, enc: 'utf-8') => string } | undefined;
  const path = get.call(process, 'node:path') as { resolve: (p: string) => string } | undefined;
  if (!fs || !path) return null;
  return { readFileSync: fs.readFileSync, resolve: path.resolve };
}

export interface ExtractIndexesOptions {
  /** Already-loaded source files. Either `files` or `paths` must be set. */
  files?: { name: string; source: string }[];
  /** Filesystem paths to read. Resolved against the process cwd. */
  paths?: string[];
  /** Variable name the extractor walks for the wrap pattern. Defaults to `q`. */
  queryVarName?: string;
}

export class ExtractFirestoreIndexesHandler {
  execute(options: ExtractIndexesOptions): ExtractResult {
    // Validate inputs before doing any work — the extractor itself
    // tolerates an empty file list, but a caller passing neither
    // `files` nor `paths` is almost certainly a bug.
    const haveFiles = Array.isArray(options.files) && options.files.length > 0;
    const havePaths = Array.isArray(options.paths) && options.paths.length > 0;
    if (!haveFiles && !havePaths) {
      return {
        success: false,
        error: {
          code: 'EXTRACT_FAILED',
          message: 'Must provide at least one of `files` or `paths`.',
          recoverable: true,
        },
      };
    }

    const files: { name: string; source: string }[] = [];
    if (haveFiles) files.push(...(options.files as { name: string; source: string }[]));

    if (havePaths) {
      const node = nodeFsPath();
      if (!node) {
        return {
          success: false,
          error: {
            code: 'EXTRACT_FAILED',
            message: 'The `paths` option reads from disk and requires a Node runtime — pass `files` with pre-loaded source instead.',
            recoverable: true,
          },
        };
      }
      for (const p of options.paths!) {
        const abs = node.resolve(p);
        let source: string;
        try {
          source = node.readFileSync(abs, 'utf-8');
        } catch (e) {
          // One unreadable path shouldn't kill the whole extraction —
          // the extractor will report per-file warnings for parse
          // errors, but reads happen here. Surface the read failure as
          // the same shape so callers don't need a separate code path.
          const message = e instanceof Error ? e.message : String(e);
          return {
            success: false,
            error: {
              code: 'EXTRACT_FAILED',
              message: `Failed to read '${p}': ${message}`,
              recoverable: false,
            },
          };
        }
        files.push({ name: p, source });
      }
    }

    return extractIndexes({
      files,
      queryVarName: options.queryVarName,
    });
  }
}
