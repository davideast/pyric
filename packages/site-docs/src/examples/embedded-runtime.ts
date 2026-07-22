import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import type { PyricExampleDefinition } from './definition';

export interface EmbeddedExampleRuntime {
  run(): Promise<unknown>;
  reset(): EmbeddedExampleRuntime;
}

/** One disposable, memory-backed runtime. Nothing escapes its iframe realm. */
export function createEmbeddedExampleRuntime(
  definition: PyricExampleDefinition,
): EmbeddedExampleRuntime {
  const sandbox = createSandboxRoot();
  const { rules, seed } = definition.firestore;

  setRules(sandbox, rules);
  if (seed) seedDocuments(sandbox, seed);

  return {
    run: () => definition.run({ sandbox }),
    reset: () => createEmbeddedExampleRuntime(definition),
  };
}
