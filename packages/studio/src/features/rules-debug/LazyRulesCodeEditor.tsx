/**
 * Lazy boundary for {@link RulesCodeEditor} (Pyric Studio F4).
 *
 * CodeMirror 6 is a sizeable dependency and the denial inspector is a deep
 * surface (Traffic → expand a deny row), so the editor is code-split into its
 * own chunk via `React.lazy`: the Studio main bundle pays nothing until a
 * denial is actually inspected. While the chunk loads, a calm monospace
 * placeholder holds the layout (and, for the read-only view, shows the source
 * immediately as plain text so nothing flashes empty).
 */
import { Suspense, lazy } from 'react';
import type { RulesCodeEditorProps } from './RulesCodeEditor.js';

const RulesCodeEditor = lazy(() => import('./RulesCodeEditor.js'));

export function LazyRulesCodeEditor(props: RulesCodeEditorProps) {
  return (
    <Suspense fallback={<EditorFallback value={props.value} minHeightRem={props.minHeightRem} />}>
      <RulesCodeEditor {...props} />
    </Suspense>
  );
}

function EditorFallback({ value, minHeightRem = 14 }: { value: string; minHeightRem?: number }) {
  return (
    <pre
      data-pyric-ui="rules-code-editor-loading"
      className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs text-slate-gray"
      style={{ minHeight: `${minHeightRem}rem` }}
    >
      {value || 'Loading editor…'}
    </pre>
  );
}
