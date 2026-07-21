import { pyricExample, type PyricExampleId } from '../examples/registry';
import { useExampleRuntime } from './use-example-runtime';

interface Props {
  id: PyricExampleId;
}

export function ExampleRuntime({ id }: Props) {
  const definition = pyricExample(id).definition;
  const { state, reset } = useExampleRuntime(definition);

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
