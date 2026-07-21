import type { LocalSandbox } from 'pyric/sandbox';

export type PyricExampleService = 'firestore' | 'auth' | 'rtdb' | 'storage';

export interface PyricExampleContext {
  sandbox: LocalSandbox;
}

export interface PyricExampleDefinition {
  id: string;
  title: string;
  description: string;
  services: readonly PyricExampleService[];
  rules?: string;
  seed?: Record<string, Record<string, unknown>>;
  run(context: PyricExampleContext): Promise<unknown>;
}

export function definePyricExample(definition: PyricExampleDefinition): PyricExampleDefinition {
  return definition;
}
