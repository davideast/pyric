/**
 * A CodeMirror 6 editor for `firestore.rules`, used by the denial inspector's
 * two rules views (Pyric Studio F4):
 *
 *   - the READ-ONLY "what happened" view of the deployed ruleset, and
 *   - the EDITABLE "re-run against an edited ruleset" buffer.
 *
 * It reuses the SAME CodeMirror 6 package set the playground's `CmEditor` uses
 * (`packages/playground/src/components/CmEditor.tsx`): there is no first-party
 * Firestore-rules language, so it falls back to the JavaScript extension for
 * highlighting + bracket matching — close enough syntactically (`service`,
 * `match`, `allow`, `if` all read as keywords), the same choice the playground
 * made.
 *
 * The rules-debug addition on top of the playground editor is DENIAL LINE
 * EMPHASIS: given the denying rule's 1-indexed `denialLine` (threaded from the
 * simulator via `RequestEvent.deniedRule.line`), it tints that line's
 * background and drops a ✗ marker in the gutter, in BOTH views, so the eye
 * lands on the rule that denied. Implemented with the real CodeMirror
 * `Decoration.line` + `gutter`/`GutterMarker` APIs (the playground only used
 * the lint gutter, which can't tint a whole line).
 *
 * Themed against the Studio semantic tokens (`--panel`, `--ink`, `--line`,
 * `--diff-remove*`) so it adapts to light/dark with the rest of the shell.
 *
 * This module imports CodeMirror eagerly; the whole module is loaded lazily by
 * `LazyRulesCodeEditor` so CodeMirror stays out of the Studio main chunk.
 */
import { useEffect, useRef } from 'react';
import { EditorState, StateField, Compartment, RangeSet, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  gutter,
  GutterMarker,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

export interface RulesCodeEditorProps {
  value: string;
  onChange?: (next: string) => void;
  /** When true (or when no `onChange` is given), the buffer is read-only. */
  readOnly?: boolean;
  /** 1-indexed source line of the denying rule to emphasise (✗ gutter + tinted
   *  line). Absent ⇒ no emphasis (implicit deny, or the sim didn't thread a
   *  line). */
  denialLine?: number;
  /** Approximate visible height. Defaults to a comfortable multi-line box. */
  minHeightRem?: number;
  ariaLabel?: string;
}

// The custom highlight palette, ported from the playground's `CmEditor` — hue
// identity preserved (keywords lavender, strings amber, literals sage), muted
// so it reads as part of the panel. Tuned for the dark resting theme.
const rulesHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6f6f80', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: '#e0b489' },
  { tag: t.regexp, color: '#e0b489' },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: '#c2a8e0' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b8d496' },
  { tag: [t.variableName, t.propertyName], color: '#dadaee' },
  { tag: t.definition(t.variableName), color: '#e8e8fa' },
  { tag: t.function(t.variableName), color: '#e0a8cc' },
  { tag: [t.typeName, t.className], color: '#9cc8e4' },
  { tag: [t.operator, t.punctuation], color: '#9898b0' },
  { tag: t.bracket, color: '#a0a0b8' },
]);

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12.5px',
    color: 'var(--ink)',
    backgroundColor: 'var(--panel)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--ink)', padding: '6px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--muted)',
    border: 'none',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(143,127,232,0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  // Denial emphasis.
  '.cm-denyLine': { backgroundColor: 'var(--diff-remove-bg)' },
  '.cm-denyGutter': { width: '1.1em' },
  '.cm-denyGutter .cm-gutterElement': {
    color: 'var(--diff-remove)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '700',
  },
});

class DenyGutterMarker extends GutterMarker {
  toDOM(): Text {
    return document.createTextNode('✗'); // ✗
  }
}
const denyMarker = new DenyGutterMarker();

/** Build the line-background + gutter-✗ extensions for a fixed 1-indexed line.
 *  Both are driven off the line's start position (mapped through doc changes)
 *  so the background tint and the ✗ marker always land on the SAME line, and
 *  stay put as the buffer is edited. */
function denialEmphasis(line: number): Extension {
  const inRange = (state: EditorState) => line >= 1 && line <= state.doc.lines;
  const lineDeco = Decoration.line({ attributes: { class: 'cm-denyLine' } });
  const decoFor = (state: EditorState): DecorationSet =>
    inRange(state) ? Decoration.set([lineDeco.range(state.doc.line(line).from)]) : Decoration.none;
  const decoField = StateField.define<DecorationSet>({
    create: decoFor,
    update: (deco, tr) => (tr.docChanged ? decoFor(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });

  const markerFor = (state: EditorState): RangeSet<GutterMarker> =>
    inRange(state) ? RangeSet.of([denyMarker.range(state.doc.line(line).from)]) : RangeSet.empty;
  const markerField = StateField.define<RangeSet<GutterMarker>>({
    create: markerFor,
    update: (v, tr) => (tr.docChanged ? markerFor(tr.state) : v),
  });
  const denyGutter = gutter({
    class: 'cm-denyGutter',
    markers: (view) => view.state.field(markerField),
  });
  return [markerField, decoField, denyGutter];
}

export function RulesCodeEditor({
  value,
  onChange,
  readOnly,
  denialLine,
  minHeightRem = 14,
  ariaLabel,
}: RulesCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const isReadOnly = readOnly || !onChange;
  const emphasisComp = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Mount once. Re-mount only when read-only-ness flips (a structural change).
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(rulesHighlight, { fallback: true }),
        javascript(), // close-enough rules highlighting (same as the playground)
        emphasisComp.current.of(denialLine ? denialEmphasis(denialLine) : []),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.editable.of(!isReadOnly),
        EditorState.readOnly.of(isReadOnly),
        ...(isReadOnly
          ? []
          : [closeBrackets(), keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab])]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReadOnly]);

  // Swap the denial-line emphasis without tearing down the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: emphasisComp.current.reconfigure(denialLine ? denialEmphasis(denialLine) : []),
    });
  }, [denialLine]);

  // Sync external value changes in (without clobbering the cursor on keystrokes).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      role="textbox"
      aria-label={ariaLabel}
      aria-readonly={isReadOnly || undefined}
      data-pyric-ui="rules-code-editor"
      className="overflow-hidden rounded-md border border-border"
      style={{ minHeight: `${minHeightRem}rem` }}
    />
  );
}

export default RulesCodeEditor;
