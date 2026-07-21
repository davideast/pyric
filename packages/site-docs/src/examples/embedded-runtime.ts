import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { createSandboxAdapter } from 'pyric/sandbox/internal';
import type { PyricExampleDefinition } from './definition';

export interface EmbeddedExampleRuntime {
  run(): Promise<unknown>;
  reset(): EmbeddedExampleRuntime;
}

/** One disposable, memory-backed runtime. Nothing escapes its iframe realm. */
export function createEmbeddedExampleRuntime(
  definition: PyricExampleDefinition,
): EmbeddedExampleRuntime {
  const adapter = createSandboxAdapter('embedded');
  const sandbox = adapter.create();

  if (definition.rules) setRules(sandbox, definition.rules);
  if (definition.seed) seedDocuments(sandbox, definition.seed);

  return {
    run: () => definition.run({ sandbox }),
    reset: () => createEmbeddedExampleRuntime(definition),
  };
}
