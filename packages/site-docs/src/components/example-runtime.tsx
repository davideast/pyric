import { pyricExample, type PyricExampleId } from '../examples/registry';
import { assertPyricSnippet } from '../examples/definition';
import { useExampleRuntime } from './use-example-runtime';

interface Props {
  id: PyricExampleId;
}

export function ExampleRuntime({ id }: Props) {
  const definition = pyricExample(id).definition;
  assertPyricSnippet(definition);
  const { state, reset } = useExampleRuntime(definition);
  const statusLabel = state.status === 'running'
    ? 'Running'
    : state.status === 'ready'
      ? 'Ready'
      : 'Error';
  const output = state.status === 'running'
    ? 'Writing notes/first…'
    : state.status === 'ready'
      ? JSON.stringify(state.output, null, 2) ?? 'The operation returned no value.'
      : state.error;

  const copyError = async () => {
    if (state.error) await navigator.clipboard.writeText(state.error);
  };

  return (
    <main className="example-runtime">
      <header>
        <div className="runtime-status" role="status" aria-live="polite">
          <span className={`status status-${state.status}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
        <button type="button" onClick={reset}>Reset sandbox</button>
      </header>
      <section
        className={`runtime-result runtime-result-${state.status}`}
        aria-labelledby="example-result-heading"
        aria-busy={state.status === 'running'}
      >
        <div className="result-heading">
          <div>
            <span>Saved document</span>
            <strong id="example-result-heading">notes/first</strong>
          </div>
          {state.status === 'error'
            ? <button type="button" className="copy-error" onClick={copyError}>Copy error</button>
            : null}
        </div>
        <pre aria-live="polite">{output}</pre>
      </section>
    </main>
  );
}
