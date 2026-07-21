import { useEffect, useRef, useState } from 'react';
import type { PyricSnippetDefinition } from '../examples/definition';
import {
  createEmbeddedExampleRuntime,
  type EmbeddedExampleRuntime,
} from '../examples/embedded-runtime';

export type ExampleRuntimeState =
  | { status: 'running'; output: null; error: null }
  | { status: 'ready'; output: unknown; error: null }
  | { status: 'error'; output: null; error: string };

export function useExampleRuntime(
  definition: PyricSnippetDefinition,
  createRuntime: (definition: PyricSnippetDefinition) => EmbeddedExampleRuntime =
    createEmbeddedExampleRuntime,
) {
  const runtime = useRef<EmbeddedExampleRuntime | null>(null);
  if (runtime.current === null) runtime.current = createRuntime(definition);

  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<ExampleRuntimeState>({
    status: 'running',
    output: null,
    error: null,
  });

  useEffect(() => {
    let active = true;
    setState({ status: 'running', output: null, error: null });
    runtime.current!.run().then(
      (output) => active && setState({ status: 'ready', output, error: null }),
      (error) => active && setState({
        status: 'error',
        output: null,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      }),
    );
    return () => { active = false; };
  }, [generation]);

  return {
    state,
    reset() {
      runtime.current = runtime.current!.reset();
      setGeneration((value) => value + 1);
    },
  };
}
