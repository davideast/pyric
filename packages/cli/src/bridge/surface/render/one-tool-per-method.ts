/**
 * The shared rendering for the surfaces that expose one tool per method.
 *
 * The three named surfaces differ only in the word order of the tool name, so
 * they share this builder and supply the order. The tool carries the record's
 * own description and its argument schema converted to JSON Schema, and its
 * call runs through `callMethod`, the one validated entry every surface uses,
 * so neither execution nor enforcement depends on which name order is served.
 */
import { toJsonSchema } from '../json-schema.js';
import { callMethod } from '../method-call.js';
import { mountedMethods } from '../method-effects.js';
import { METHODS } from '../methods/index.js';
import { selectOperation } from '../method-types.js';
import type { Method } from '../method-types.js';
import type { RenderedSurface, RenderedTool, RenderOptions } from '../types.js';
import { spellName, wordsFor, type MethodWords } from './method-words.js';

/**
 * How one surface orders a method's name words. The order is the whole
 * difference between the three named surfaces; joining the words, and dropping
 * an empty one, is the same for all of them and belongs here.
 */
export type NamePattern = (words: MethodWords) => readonly string[];

/** Render one tool per mounted method record under the supplied word order. */
export function renderOneToolPerMethod(
  nameFor: NamePattern,
  options?: RenderOptions,
): RenderedSurface {
  const allowProduction = options?.allowProduction ?? false;
  const tools: RenderedTool[] = [];
  const byToolName = new Map<string, Method>();

  for (const method of mountedMethods(METHODS, allowProduction)) {
    const name = spellName(nameFor(wordsFor(method.key)));
    if (byToolName.has(name)) {
      throw new Error(`rendered tool name '${name}' is claimed by two methods`);
    }
    byToolName.set(name, method);
    tools.push({
      name,
      description: `${method.signature}: ${method.description}`,
      inputSchema: toJsonSchema(method.args),
      execute: (args, ctx) => callMethod(method, args, ctx, allowProduction),
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
