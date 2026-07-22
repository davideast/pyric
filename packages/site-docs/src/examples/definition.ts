import type { LocalSandbox } from 'pyric/sandbox';

export interface PyricExampleContext {
  sandbox: LocalSandbox;
}

interface PyricExampleMetadata {
  header: string;
  subLabel: string;
  summary: string;
  docsPath: string;
  service: 'firestore';
}

export interface PyricSnippetDefinition extends PyricExampleMetadata {
  presentation?: 'snippet';
  firestore: {
    rules: string;
    seed?: Record<string, Record<string, unknown>>;
  };
  run(context: PyricExampleContext): Promise<unknown>;
}

export interface PyricShowcaseDefinition extends PyricExampleMetadata {
  presentation: 'showcase';
  renderer: 'chess';
}

export type PyricExampleDefinition = PyricSnippetDefinition | PyricShowcaseDefinition;

export function definePyricExample<T extends PyricExampleDefinition>(definition: T): T {
  return definition;
}

export function assertPyricSnippet(
  definition: PyricExampleDefinition,
): asserts definition is PyricSnippetDefinition {
  if (definition.presentation === 'showcase') {
    throw new Error(`Pyric showcase '${definition.header}' cannot use the generic example runtime`);
  }
}
