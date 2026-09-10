/**
 * How one service tool's description is written from its method records.
 *
 * The description is the only thing a model reads before its first call, so it
 * carries every signature, grouped by what the call does: reads first, then
 * writes, then the destructive methods with the confirmation they take, then
 * the production methods with the note that they are not mounted by default.
 * Grouping by effect is what lets a model see the safe half of a tool without
 * reading the whole list.
 *
 * The text is rendered into `descriptions.generated.ts` at build time and that
 * file is what `tools/list` serves, so a description can never drift from the
 * records without a test noticing.
 */
import { DESCRIBE_METHOD } from './method-validation.js';
import type { Method, MethodEffect, Tool } from './method-types.js';

/** The longest a rendered description may be. */
export const DESCRIPTION_LIMIT = 1600;

/** The effect groups, in the order a description lists them. */
const GROUPS: ReadonlyArray<{ effect: MethodEffect; heading: string }> = [
  { effect: 'read', heading: 'Read methods' },
  { effect: 'write', heading: 'Write methods' },
  { effect: 'destructive', heading: 'Destructive methods, which require confirm: true' },
  { effect: 'production', heading: 'Production methods, which are not mounted by default' },
];

/** The sentence every tool ends with, pointing at the schema an agent can ask for. */
const DESCRIBE_SENTENCE = `Call method '${DESCRIBE_METHOD}' with args { method } to read the full schema and an example call for one method.`;

/** One method's line: its signature and the sentence that chooses it. */
function line(method: Method): string {
  return `${method.signature}: ${method.description}`;
}

/** One tool's description, from its records. */
export function renderToolDescription(tool: Tool): string {
  const sections: string[] = [tool.intro];
  for (const group of GROUPS) {
    const members = tool.methods.filter((method) => method.effect === group.effect);
    if (members.length === 0) continue;
    sections.push(`${group.heading}: ${members.map(line).join(' ')}`);
  }
  sections.push(DESCRIBE_SENTENCE);
  const description = sections.join(' ');
  if (description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `${tool.name} description is ${description.length} characters, over the ${DESCRIPTION_LIMIT} limit`,
    );
  }
  return description;
}

/** Every tool's description, keyed by tool name. */
export function renderToolDescriptions(tools: readonly Tool[]): Record<string, string> {
  const descriptions: Record<string, string> = {};
  for (const tool of tools) descriptions[tool.name] = renderToolDescription(tool);
  return descriptions;
}
