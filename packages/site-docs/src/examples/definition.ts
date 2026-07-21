import type { LocalSandbox } from 'pyric/sandbox';

export interface PyricExampleContext {
  sandbox: LocalSandbox;
}

export interface PyricExampleDefinition {
  id: string;
  title: string;
  description: string;
  service: 'firestore';
  firestore: {
    rules: string;
    seed?: Record<string, Record<string, unknown>>;
  };
  run(context: PyricExampleContext): Promise<unknown>;
}

export function definePyricExample(definition: PyricExampleDefinition): PyricExampleDefinition {
  return definition;
}
