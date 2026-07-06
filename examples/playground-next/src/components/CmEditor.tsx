/**
 * CodeMirror 6 wrapper used by the three workspace editors. One
 * component, three language flavors:
 *
 *   - `rules`  → Firestore Security Rules. No first-party language
 *     package exists, so we fall back to the JavaScript extension —
 *     close enough syntactically for highlighting and bracket matching.
 *   - `js`     → JavaScript (the Sandbox-tab script).
 *   - `tsx`    → TypeScript + JSX (the App-tab module).
 *
 * Themed to match the playground's `content-bg` / `soft-white`
 * palette (Tailwind tokens). The base styles come straight from
 * `EditorView.theme(...)`; we don't pull `one-dark` because it
 * recolors backgrounds in ways that fight the surrounding chrome.
 *
 * `lintMessages` lets the host (the Rules editor specifically) wire
 * structured lint warnings into CodeMirror's gutter — markers appear
 * inline with the offending lines and the summary strip below the
 * editor still renders the same list in legible form.
 */
import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';

export type CmLanguage = 'rules' | 'js' | 'tsx';

export interface CmLintMessage {
  /** 1-based line. Optional — when absent the marker lives at line 1. */
  line?: number;
  /** 1-based column. Falls back to 1 when absent. */
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface CmEditorProps {
  /** Focus the editor on mount. Used by editor wrappers that flip
   *  from a zero-state view → editor view: the click that dismisses
   *  the zero state should drop the cursor straight into the buffer. */
  autoFocus?: boolean;
  value: string;
  onChange: (next: string) => void;
  language: CmLanguage;
  /** Marker source for the gutter — only the Rules editor uses it today. */
  lintMessages?: CmLintMessage[];
  placeholder?: string;
}

function languageExtension(lang: CmLanguage) {
  if (lang === 'tsx') return javascript({ jsx: true, typescript: true });
  if (lang === 'rules') return javascript(); // close-enough highlight
  return javascript();
}

/**
 * Custom syntax highlight palette. CodeMirror's `defaultHighlightStyle`
 * uses saturated colors meant to be readable across themes — against
 * the playground's dark `content-bg` they're loud (vivid red strings,
 * neon purple keywords). This palette keeps the hue identity (warm =
 * literals, cool-purple = keywords, blue = identifiers, gray = comments)
 * but drops luminance + saturation so the colors read as part of the
 * panel rather than ornament on top of it.
 */
const playgroundHighlight = HighlightStyle.define([
  // Comments — clearly subordinate but still readable. Italic preserves
  // the "this is an aside" cue.
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6f6f80', fontStyle: 'italic' },
  { tag: t.docComment, color: '#7f7f90', fontStyle: 'italic' },

  // Strings + regex — warm amber, a touch brighter than the slate
  // family so they pop just enough to spot at a glance.
  { tag: [t.string, t.special(t.string)], color: '#e0b489' },
  { tag: t.regexp, color: '#e0b489' },

  // Keywords (`if`, `return`, `service`, `match`, `allow`) — lavender
  // with enough saturation to read clearly while staying soft.
  {
    tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
    color: '#c2a8e0',
  },

  // Literal values (numbers, bools, null) — sage green. Brighter than
  // the previous pass so `null` / `true` / `false` are immediately
  // visible inside a long rule.
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b8d496' },

  // Plain identifiers — soft off-white. Default body-text color for
  // most code; sits a half-step below `soft-white` so brackets and
  // operators can register against it.
  { tag: [t.variableName, t.propertyName], color: '#dadaee' },
  { tag: t.definition(t.variableName), color: '#e8e8fa' },

  // Function call sites — rose-purple. Distinct from keywords and
  // identifiers without competing with them for attention.
  { tag: t.function(t.variableName), color: '#e0a8cc' },

  // Type / class names — soft sky blue. Used by path wildcards
  // (`{db}`, `{itemId}`) in our rules editor — the main "you wrote a
  // variable here" cue when reading rules.
  { tag: [t.typeName, t.className], color: '#9cc8e4' },

  // Operators, punctuation, brackets — slate. Same hue family as the
  // gutter line numbers so the editor reads as one surface.
  { tag: [t.operator, t.punctuation], color: '#9898b0' },
  { tag: t.bracket, color: '#a0a0b8' },

  // JSX/HTML-ish (for the App TSX editor).
  { tag: t.attributeName, color: '#e0a8cc' },
  { tag: t.attributeValue, color: '#e0b489' },
  { tag: t.tagName, color: '#9cc8e4' },

  // Markdown-ish — rarely hit in our editors, included for completeness.
  { tag: t.heading, color: '#fbfbfe', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: '#9cc8e4', textDecoration: 'underline' },
]);

/**
 * Custom dark theme. Sticks to the playground's two background tones
 * + soft-white text so the editor reads as part of the panel rather
 * than a transplant.
 */
const playgroundTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13px',
      color: '#fbfbfe',
      backgroundColor: '#16161a',
    },
    '.cm-scroller': {
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      lineHeight: '1.55',
    },
    '.cm-content': { caretColor: '#fbfbfe', padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: '#16161a',
      color: '#72728a',
      border: 'none',
      borderRight: '1px solid #2a2a35',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#fbfbfe' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#2a2a40 !important' },
    '.cm-cursor': { borderLeftColor: '#fbfbfe' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
    '.cm-lintRange-error': { textDecoration: 'underline wavy #f0a0a0' },
    '.cm-lintRange-warning': { textDecoration: 'underline wavy #e6c79c' },
  },
  { dark: true },
);

function buildLinter(getMessages: () => CmLintMessage[]) {
  return linter((view) => {
    const messages = getMessages();
    const out: Diagnostic[] = [];
    const doc = view.state.doc;
    for (const m of messages) {
      const lineNo = Math.max(1, Math.min(doc.lines, m.line ?? 1));
      const line = doc.line(lineNo);
      const col = Math.max(0, Math.min(line.length, (m.column ?? 1) - 1));
      const from = line.from + col;
      // Highlight to end of line; for column-anchored issues this is
      // a forgiving span that still reads as "this line."
      const to = line.to;
      out.push({
        from,
        to: from === to ? Math.min(from + 1, doc.length) : to,
        severity: m.severity,
        message: m.message,
      });
    }
    return out;
  });
}

export function CmEditor({ autoFocus, value, onChange, language, lintMessages, placeholder }: CmEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Compartment holding the latest lint source so updates can swap it
  // without tearing down the editor state.
  const lintComp = useRef(new Compartment());
  // Capture latest props in refs so the linter source (closed-over at
  // mount time) always reads the current value.
  const messagesRef = useRef<CmLintMessage[] | undefined>(lintMessages);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    messagesRef.current = lintMessages;
    // Force a re-lint when messages change.
    const v = viewRef.current;
    if (v) {
      v.dispatch({ effects: lintComp.current.reconfigure(buildLinter(() => messagesRef.current ?? [])) });
    }
  }, [lintMessages]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Mount the editor once. Subsequent value changes are pushed via a
  // separate effect; rebuilding the state on every render would
  // collapse undo history and re-mount expensive extensions.
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        lintGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(playgroundHighlight, { fallback: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        languageExtension(language),
        lintComp.current.of(buildLinter(() => messagesRef.current ?? [])),
        playgroundTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Sync external `value` changes back into the editor — but only
  // when they differ from the current doc, otherwise we'd clobber
  // the user's cursor on every keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      data-placeholder={placeholder}
      className="w-full h-full bg-content-bg overflow-hidden"
    />
  );
}
