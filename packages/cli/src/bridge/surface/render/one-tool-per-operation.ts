/**
 * The shared rendering for the variants that expose one tool per operation.
 *
 * The three named variants differ only in the word order of the tool name, so
 * they share this builder and supply the pattern. The tool carries the
 * operation's own description and its object schema converted to JSON Schema,
 * and its handler is the operation's single handler, so execution does not
 * depend on which variant is being served.
 */
import { toJsonSchema } from '../json-schema.js';
import type { Operation, RenderedSurface, RenderedTool } from '../types.js';

/** How one variant spells an operation's tool name. */
export type NamePattern = (operation: Operation) => string;

/** Render one tool per operation under the supplied name pattern. */
export function renderOneToolPerOperation(
  operations: readonly Operation[],
  nameFor: NamePattern,
): RenderedSurface {
  const tools: RenderedTool[] = [];
  const byToolName = new Map<string, string>();

  for (const operation of operations) {
    const name = nameFor(operation);
    if (byToolName.has(name)) {
      throw new Error(`rendered tool name '${name}' is claimed by two operations`);
    }
    byToolName.set(name, operation.id);
    tools.push({
      name,
      description: operation.description,
      inputSchema: toJsonSchema(operation.parameters),
      execute: (args, ctx) => operation.handler(args, ctx),
    });
  }

  return {
    tools,
    resolve(toolName) {
      return { operation: byToolName.get(toolName) ?? null, action: null };
    },
  };
}
