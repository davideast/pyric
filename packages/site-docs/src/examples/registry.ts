import firestoreFirstWrite from './firestore-first-write';
import firestoreFirstWriteSource from './firestore-first-write/run.ts?raw';
import type { PyricExampleDefinition } from './definition';

export interface RegisteredPyricExample {
  definition: PyricExampleDefinition;
  source: string;
}

export const PYRIC_EXAMPLES = {
  'firestore-first-write': {
    definition: firestoreFirstWrite,
    source: firestoreFirstWriteSource,
  },
} as const satisfies Record<string, RegisteredPyricExample>;

export type PyricExampleId = keyof typeof PYRIC_EXAMPLES;

export function pyricExample(id: string): RegisteredPyricExample {
  const example = PYRIC_EXAMPLES[id as PyricExampleId];
  if (!example) throw new Error(`Unknown Pyric example: ${id}`);
  return example;
}
