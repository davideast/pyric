/**
 * The natural-language seed assist: turn a request ("add 10 users and 50 notes")
 * into Firestore documents. The model calls `propose_seed` with the generated
 * docs; they are PREVIEWED, then applied as admin writes (preview-before-apply).
 * The write rides the in-repo admin handle (no playground tool lifted).
 */

import type { ToolHandler, ToolResult } from '@inbrowser/agent';
import type { SeedOp } from '../../shell/studio-data.js';

export const SEED_SYSTEM =
  'You generate Firestore seed data for a LOCAL sandbox from a natural-language ' +
  'request. Produce realistic documents; when existing collections are given, ' +
  'match their names + likely shapes. Call the propose_seed tool ONCE with all the ' +
  'operations (each { path, data }); paths are "collection/docId" with short ids. ' +
  'Do not exceed 100 documents. After proposing, briefly summarize what you made.';

export function buildSeedPrompt(input: { request: string; collections: readonly string[] }): string {
  const lines = [`Request: ${input.request}`];
  if (input.collections.length) {
    lines.push('', `Existing collections: ${input.collections.join(', ')}.`);
  }
  lines.push('', 'Generate the documents and call propose_seed with them.');
  return lines.join('\n');
}

/** The `propose_seed` tool: validate + capture the generated ops (no write). */
export function makeProposeSeedTool(deps: { onProposed: (ops: SeedOp[]) => void }): ToolHandler {
  return {
    name: 'propose_seed',
    description:
      'Propose seed documents to write to Firestore. Pass operations as an array ' +
      'of { path, data } (path is "collection/docId"). Returns a summary; the user ' +
      'reviews the preview and applies. Call once with all documents.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'The documents to create.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'collection/docId' },
              data: { type: 'object', description: 'The document fields.' },
            },
            required: ['path', 'data'],
          },
        },
      },
      required: ['operations'],
    },
    async execute(args): Promise<ToolResult> {
      const raw = (args as { operations?: unknown }).operations;
      if (!Array.isArray(raw)) return { ok: false, summary: 'No operations provided.' };
      const ops = validateSeedOps(raw);
      if (ops.length === 0) return { ok: false, summary: 'No valid { path, data } operations.' };
      if (ops.length > 100) return { ok: false, summary: `Too many documents (${ops.length}); the cap is 100.` };
      deps.onProposed(ops);
      const collections = new Set(ops.map((o) => o.path.split('/')[0]));
      return {
        ok: true,
        summary: `Proposed ${ops.length} document(s) across ${collections.size} collection(s): ${[...collections].join(', ')}.`,
        data: { count: ops.length },
      };
    },
  };
}

/** Keep only well-formed `{ path: "collection/doc", data: {} }` ops. */
export function validateSeedOps(raw: readonly unknown[]): SeedOp[] {
  const ops: SeedOp[] = [];
  for (const o of raw) {
    const op = o as { path?: unknown; data?: unknown };
    if (
      typeof op.path === 'string' &&
      op.path.includes('/') &&
      !op.path.startsWith('/') &&
      op.data != null &&
      typeof op.data === 'object' &&
      !Array.isArray(op.data)
    ) {
      ops.push({ path: op.path, data: op.data as Record<string, unknown> });
    }
  }
  return ops;
}
