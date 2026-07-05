/**
 * Browser-safe `firestore_extract_indexes` factory. Returns a single
 * `ToolHandler` wrapping the inner `extractIndexes()` AST pass with
 * inline `files` only (no `paths` mode — that's Node-only and lives
 * on the legacy SDK's `firestore_extract_indexes` defineTool entry,
 * soon to be retired).
 *
 * Split from the broader rules-tooling factories so browser callers
 * (the playground's deploy + extract surfaces) can opt into just
 * the static-analysis tool without pulling in any other rules
 * machinery.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { extractIndexes } from './extract/extractor.js';

interface ExtractIndexesArgs {
  files: Array<{ name: string; source: string }>;
  queryVarName?: string;
}

export function createFirestoreExtractTool(): ToolHandler {
  return {
    name: 'firestore_extract_indexes',
    description:
      'Statically extract composite-index requirements from JS/TS source that uses the Firebase modular SDK\'s `query(collection(...), where(...), orderBy(...))` pattern. Returns a `firestore.indexes.json`-shaped `config`, per-collection `signals` (overshootSuspected = enumerated shapes > 3 — cue to add JSDoc annotations on the function), `annotationsApplied`, and per-file `warnings`. Recognized JSDoc annotations: `@firestore-mutex { f1, f2 }` (drop combos with 2+ of these together), `@firestore-required f1, f2` (drop combos missing any required field), `@firestore-budget N` (soft cap; surfaces warning when exceeded). Layer 2.5 follows same-file wrapper calls one level deep. Limits: same-file only, single-level inlining, root-context only, chain var must appear by identifier in the args.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
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
        queryVarName: {
          type: 'string',
          description: 'Variable name the extractor walks for the wrap pattern. Defaults to "q".',
        },
      },
      required: ['files'],
    },
    async execute(args) {
      const { files, queryVarName } = args as ExtractIndexesArgs;
      try {
        const result = extractIndexes({
          files,
          ...(queryVarName !== undefined && { queryVarName }),
        });
        return {
          ok: result.success,
          summary: result.success
            ? `Extracted ${result.data.config.indexes.length} composite index(es) from ${result.data.shapesEnumerated} query shape(s)`
            : `firestore_extract_indexes failed: ${result.error.message}`,
          data: result,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          summary: `firestore_extract_indexes failed: ${message}`,
          data: { success: false, error: { code: 'EXTRACT_INDEXES_FAILED', message, recoverable: false } },
        };
      }
    },
  };
}
