/**
 * Browser-safe `firestore_extract_indexes` factory wrapping `extractIndexes`
 * with inline `files`.
 */
import type { ToolHandler } from '../sandbox/internal/tool-handler.js';
import { extractIndexes } from './extract/extractor.js';

interface ExtractIndexesArgs {
  files: Array<{ name: string; source: string }>;
}

export function createFirestoreExtractTool(): ToolHandler {
  return {
    name: 'firestore_extract_indexes',
    description:
      'Statically extract composite-index requirements from JS/TS source using the Firebase modular SDK `query(...)` API across inline readers, conditional query chains, `and`/`or` composite filters, `collectionGroup(...)`, and cross-file helper functions. Returns a `firestore.indexes.json`-shaped `config`, per-collection `signals`, and per-file `warnings`.',
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
              name: {
                type: 'string',
                description: 'File name or relative path for module resolution and diagnostics.',
              },
              source: { type: 'string', description: 'JS/TS source to scan.' },
            },
            required: ['name', 'source'],
          },
        },
      },
      required: ['files'],
    },
    async execute(args) {
      const { files } = args as ExtractIndexesArgs;
      try {
        const result = extractIndexes({ files });
        let summary = '';
        if (result.success) {
          summary = `Extracted ${result.data.config.indexes.length} composite index(es) from ${result.data.shapesEnumerated} query shape(s)`;
        } else {
          summary = `firestore_extract_indexes failed: ${result.error.message}`;
        }
        return {
          ok: result.success,
          summary,
          data: result,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          summary: `firestore_extract_indexes failed: ${message}`,
          data: {
            success: false,
            error: { code: 'EXTRACT_INDEXES_FAILED', message, recoverable: false },
          },
        };
      }
    },
  };
}
