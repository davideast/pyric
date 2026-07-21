import type { PyricExampleDefinition } from './definition';

export interface RegisteredPyricExample {
  definition: PyricExampleDefinition;
  source: string;
}

const definitions = import.meta.glob<PyricExampleDefinition>('./*/definition.ts', {
  eager: true,
  import: 'default',
});
const sources = import.meta.glob<string>('./*/run.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
});

const entries = Object.entries(definitions).map(([path, definition]) => {
  const match = path.match(/^\.\/([^/]+)\/definition\.ts$/);
  if (!match) throw new Error(`Invalid Pyric example definition path: ${path}`);
  const id = match[1]!;
  const source = sources[`./${id}/run.ts`];
  if (source === undefined) throw new Error(`Pyric example '${id}' has no run.ts source`);
  return [id, { definition, source }] as const;
});

export const PYRIC_EXAMPLES: Readonly<Record<string, RegisteredPyricExample>> =
  Object.freeze(Object.fromEntries(entries));

export type PyricExampleId = string;

export function pyricExample(id: string): RegisteredPyricExample {
  const example = PYRIC_EXAMPLES[id];
  if (!example) throw new Error(`Unknown Pyric example: ${id}`);
  return example;
}
