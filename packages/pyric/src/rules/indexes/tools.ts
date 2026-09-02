/**
 * Node-only `firestore_extract_indexes` factory backing the
 * `firestore_indexes.generate` MCP operation.
 *
 * Wraps `ExtractFirestoreIndexesHandler` (which already accepts `paths` —
 * read from disk — alongside inline `files`) and adds an optional `out`
 * write: the same `firestore.indexes.json` write `pyric firestore indexes
 * generate` performs. Both the disk read (inside the handler) and the disk
 * write here need a Node runtime, so this factory lives on `pyric/rules/internal/node`
 * next to `createFirestoreRulesTools`, not on the browser-safe
 * `pyric/rules/extract` subpath alongside `createFirestoreExtractTool`
 * (files-only, no disk access).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import type { ToolHandler } from '@inbrowser/agent';
import { ExtractFirestoreIndexesHandler, type ExtractIndexesOptions } from './extractHandler.js';

interface ExtractIndexesToolArgs {
  files?: ExtractIndexesOptions['files'];
  paths?: string[];
  queryVarName?: string;
  /** When set, write the generated `firestore.indexes.json`-shaped config here (resolved against the working directory) in addition to returning it. */
  out?: string;
}

export function createFirestoreIndexesTools(): ToolHandler[] {
  return [
    {
      name: 'firestore_extract_indexes',
      description:
        'Statically extract composite-index requirements from JS/TS source that uses the Firebase modular SDK\'s `query(collection(...), where(...), orderBy(...))` pattern. Returns a `firestore.indexes.json`-shaped `config`, per-collection `signals` (overshootSuspected = enumerated shapes > 3 — cue to add JSDoc annotations on the function), `annotationsApplied`, and per-file `warnings`. Recognized JSDoc annotations: `@firestore-mutex { f1, f2 }` (drop combos with 2+ of these together), `@firestore-required f1, f2` (drop combos missing any required field), `@firestore-budget N` (soft cap; surfaces warning when exceeded). Accepts inline `files` or on-disk `paths` (resolved against the working directory); provide at least one. `out` additionally writes the generated config to a `firestore.indexes.json`-shaped file (resolved against the working directory).',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Inline source files to scan.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'File name for diagnostics — does not need to exist on disk.' },
                source: { type: 'string', description: 'JS/TS source to scan.' },
              },
              required: ['name', 'source'],
            },
          },
          paths: {
            type: 'array',
            description: 'Filesystem paths to scan, resolved against the working directory.',
            items: { type: 'string' },
          },
          queryVarName: {
            type: 'string',
            description: 'Variable name the extractor walks for the wrap pattern. Defaults to "q".',
          },
          out: {
            type: 'string',
            description: 'Write the generated firestore.indexes.json-shaped config to this path (resolved against the working directory), in addition to returning it.',
          },
        },
      },
      async execute(args) {
        const { files, paths, queryVarName, out } = args as ExtractIndexesToolArgs;
        const result = new ExtractFirestoreIndexesHandler().execute({
          ...(files !== undefined && { files }),
          ...(paths !== undefined && { paths }),
          ...(queryVarName !== undefined && { queryVarName }),
        });
        if (result.success && out) {
          const outputPath = resolvePath(out);
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, `${JSON.stringify(result.data.config, null, 2)}\n`, 'utf-8');
        }
        return {
          ok: result.success,
          summary: result.success
            ? `Extracted ${result.data.config.indexes.length} composite index(es) from ${result.data.shapesEnumerated} query shape(s)${out ? `; wrote ${resolvePath(out)}` : ''}`
            : `firestore_extract_indexes failed: ${result.error.message}`,
          data: result,
        };
      },
    },
  ];
}
