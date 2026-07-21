import { useEffect, useRef, useState } from 'react';
import { createEmbeddedExampleRuntime } from '../examples/embedded-runtime';
import { pyricExample, type PyricExampleId } from '../examples/registry';

interface Props {
  id: PyricExampleId;
}

type State =
  | { status: 'running'; output: null; error: null }
  | { status: 'ready'; output: unknown; error: null }
  | { status: 'error'; output: null; error: string };

export function ExampleRuntime({ id }: Props) {
  const definition = pyricExample(id).definition;
  const runtime = useRef(createEmbeddedExampleRuntime(definition));
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<State>({ status: 'running', output: null, error: null });

  useEffect(() => {
    let active = true;
    setState({ status: 'running', output: null, error: null });
    runtime.current.run().then(
      (output) => active && setState({ status: 'ready', output, error: null }),
      (error) => active && setState({
        status: 'error',
        output: null,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      }),
    );
    return () => { active = false; };
  }, [generation]);

  const reset = () => {
    runtime.current = runtime.current.reset();
    setGeneration((value) => value + 1);
  };

  const copyError = async () => {
    if (state.error) await navigator.clipboard.writeText(state.error);
  };

  return (
    <main className="example-runtime">
      <header>
        <span className={`status status-${state.status}`} aria-hidden="true" />
        <strong>{definition.title}</strong>
        <button type="button" onClick={reset}>Reset sandbox</button>
      </header>
      <p>{definition.description}</p>
      <pre aria-live="polite">{state.status === 'running'
        ? 'Running…'
        : state.status === 'ready'
          ? JSON.stringify(state.output, null, 2)
          : state.error}</pre>
      {state.status === 'error'
        ? <button type="button" className="copy-error" onClick={copyError}>Copy error</button>
        : null}
    </main>
  );
}
