import { useState } from 'react';
import { asVectorView, type VectorView } from '../types.js';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

/** How many leading components to show in the truncated preview. The
 *  mock (`c-data.html`) renders four then an ellipsis. */
const PREVIEW_COUNT = 4;

/**
 * Render a `[a, b, c, … ]` preview of the first {@link PREVIEW_COUNT}
 * components. A vector that's already short enough is shown in full
 * without the trailing ellipsis.
 */
function previewText(values: number[]): string {
  if (values.length <= PREVIEW_COUNT) {
    return `[${values.join(', ')}]`;
  }
  const head = values.slice(0, PREVIEW_COUNT).join(', ');
  return `[${head}, …]`;
}

/**
 * Read view for a vector (embedding). Mirrors the mock: a
 * `vector · <dims>` type chip plus a truncated value preview. The full
 * 768-float array is never rendered inline — it's noise and a perf
 * hazard. `data-dimension` carries the dimension for styling/queries.
 */
function VectorDisplay({ value, path }: FieldDisplayProps<unknown>) {
  const view = asVectorView(value);
  if (!view) {
    // Should be unreachable: the renderer only dispatches here when
    // `inferType` already classified the value as `vector`. Render a
    // defensive empty marker rather than throwing.
    return (
      <span data-pyric-field-type="vector" data-pyric-field-path={path} />
    );
  }
  return (
    <span
      data-pyric-field-type="vector"
      data-pyric-field-path={path}
      data-dimension={String(view.dimension)}
    >
      <span data-pyric-vector-dims>{`vector · ${view.dimension}`}</span>
      <span data-pyric-vector-preview>{previewText(view.values)}</span>
    </span>
  );
}

/**
 * Result of parsing the raw-replace textarea. `ok` carries the new
 * wire-sentinel value to commit; otherwise `error` is a human message.
 * Exported (and pure) so the parse/validation contract is unit-testable
 * without the JSDOM text-input event path, which is broken under this
 * repo's bun:test + JSDOM setup (see DocumentEditor.test.tsx note).
 */
export type ParsedVectorInput =
  | { ok: true; value: { __type__: '__vector__'; value: number[] } }
  | { ok: false; error: string };

/**
 * Parse the textarea contents into a wire-sentinel vector, or an error.
 * Accepts only a JSON array of numbers — the whole-value replace
 * contract. Anything else (bad JSON, non-array, non-numeric element)
 * is rejected and the previous value is kept by the caller.
 */
export function parseVectorInput(text: string): ParsedVectorInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
    return { ok: false, error: 'Expected a JSON array of numbers' };
  }
  return { ok: true, value: { __type__: '__vector__', value: parsed } };
}

/**
 * Edit affordance for a vector. Deliberately NOT a per-element grid —
 * a 768-dim embedding isn't hand-tuned float by float. The contract is
 * "replace the whole value": paste a JSON number array and commit. The
 * dimension + a note are shown so the editor is honest about what it is.
 *
 * On commit, we emit the value back in the same wire-sentinel shape the
 * read side already understands (`{__type__:'__vector__', value}`), so a
 * round-trip through `inferType` re-classifies it as `vector`. Invalid
 * JSON / non-numeric input leaves the previous value in place (same
 * forgiving stance as the bytes + geopoint editors).
 */
function VectorEdit({ value, onChange, error, path }: FieldEditProps<unknown>) {
  const view = asVectorView(value);
  const initial = view ? JSON.stringify(view.values) : '[]';
  const [draft, setDraft] = useState(initial);
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  const commit = (text: string) => {
    setDraft(text);
    const result = parseVectorInput(text);
    if (!result.ok) {
      setParseError(result.error);
      return;
    }
    setParseError(undefined);
    // Re-emit in the wire-sentinel shape so the read side + inferType
    // recognize it as a vector again without depending on a backend
    // VectorValue class being importable here.
    onChange(result.value);
  };

  const dims = view ? view.dimension : 0;
  const shown = parseError ?? error;

  return (
    <label
      data-pyric-field-type="vector"
      data-pyric-field-path={path}
      data-dimension={String(dims)}
      data-pyric-error={shown ? '' : undefined}
    >
      <span data-pyric-vector-dims>{`vector · ${dims}`}</span>
      <span data-pyric-vector-note>Replace whole. Paste a JSON number array.</span>
      <textarea
        data-pyric-vector-raw
        value={draft}
        onChange={(e) => commit(e.target.value)}
        aria-invalid={shown ? 'true' : undefined}
        aria-label="Vector value (JSON number array)"
      />
      {shown ? <span data-pyric-error-message>{shown}</span> : null}
    </label>
  );
}

export const vectorEditor: FieldEditorContract<unknown> = {
  type: 'vector',
  Display: VectorDisplay,
  Edit: VectorEdit,
};

export type { VectorView };
