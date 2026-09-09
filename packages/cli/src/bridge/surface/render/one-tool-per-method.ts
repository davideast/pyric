/**
 * The shared rendering for the surfaces that expose one tool per method.
 *
 * The three named surfaces differ only in the word order of the tool name, so
 * they share this builder and supply the pattern. The tool carries the record's
 * own description and its argument schema converted to JSON Schema, and its
 * handler is the record's single handler, so execution does not depend on which
 * name order is being served.
 */
import { toJsonSchema } from '../json-schema.js';
import { METHODS } from '../methods/index.js';
import { selectOperation } from '../method-types.js';
import type { Method } from '../method-types.js';
import type { RenderedSurface, RenderedTool } from '../types.js';
import { wordsFor, type MethodWords } from './method-words.js';

/** How one surface spells a method's tool name. */
export type NamePattern = (words: MethodWords) => string;

/** Render one tool per method record under the supplied name pattern. */
export function renderOneToolPerMethod(nameFor: NamePattern): RenderedSurface {
  const tools: RenderedTool[] = [];
  const byToolName = new Map<string, Method>();

  for (const method of METHODS) {
    const name = nameFor(wordsFor(method.key));
    if (byToolName.has(name)) {
      throw new Error(`rendered tool name '${name}' is claimed by two methods`);
    }
    byToolName.set(name, method);
    tools.push({
      name,
      description: `${method.signature}: ${method.description}`,
      inputSchema: toJsonSchema(method.args),
      execute: (args, ctx) => method.handler(args, ctx),
    });
  }

  return {
    tools,
    resolve(toolName, args) {
      const method = byToolName.get(toolName);
      if (method === undefined) return { operation: null, action: null };
      return { operation: selectOperation(method, args), action: null };
    },
  };
}
