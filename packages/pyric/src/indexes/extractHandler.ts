/**
 * Handler for `firestore_extract_indexes`. Statically analyzes JS/TS source
 * for modular Firestore queries and emits a `firestore.indexes.json`-shaped
 * config plus per-collection shape signals and diagnostics.
 *
 * BROWSER-CLEAN: zero static `node:*` imports. Disk `paths` resolution
 * acquires `node:fs`/`node:path` lazily via `process.getBuiltinModule`.
 */
import { posixNormalize, toPosixPath } from '../assurance-surface/code/posix-path.js';
import { loadDiskProject } from './disk-project.js';
import { extractIndexes } from './extract/extractor.js';
import type { ExtractResult } from './extract/types.js';

export interface ExtractIndexesOptions {
  /** Pre-loaded source files. Either `files` or `paths` must be non-empty. */
  files?: { name: string; source: string }[];
  /** Filesystem file or directory paths to scan. Resolved against `projectDir` or cwd. */
  paths?: string[];
  /** Optional project root directory used to resolve relative `paths` and `tsconfig.json`. */
  projectDir?: string;
}

function toInlineRelPath(rawName: string, index: number): string {
  const posix = toPosixPath(rawName).trim().replace(/^(?:\.\/|\/)+/, '');
  const normalized = posixNormalize(`/${posix}`).replace(/^\/+/, '');
  if (!normalized) return `__inline__/file_${index}.ts`;
  return `__inline__/${normalized}`;
}

export class ExtractFirestoreIndexesHandler {
  execute(options: ExtractIndexesOptions): ExtractResult {
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

    if (!havePaths || !options.paths) {
      return extractIndexes({ files: options.files ?? [] });
    }

    const loaded = loadDiskProject(options.paths, options.projectDir);
    if (!loaded.ok) {
      return {
        success: false,
        error: {
          code: 'EXTRACT_FAILED',
          message: loaded.message,
          recoverable: loaded.recoverable,
        },
      };
    }

    const files: { name: string; source: string; displayName?: string }[] = [...loaded.files];
    const clientRoots = [...loaded.clientRoots];

    if (haveFiles && options.files) {
      for (let i = 0; i < options.files.length; i += 1) {
        const entry = options.files[i]!;
        const inlineKey = toInlineRelPath(entry.name, i);
        files.push({ name: inlineKey, source: entry.source, displayName: entry.name });
        clientRoots.push(inlineKey);
      }
    }

    return extractIndexes({
      root: loaded.root,
      files,
      configs: loaded.configs,
      clientRoots,
    });
  }
}
