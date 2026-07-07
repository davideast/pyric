/**
 * Single source of truth for rendering model-authored prose as
 * markdown. Used by every surface the model writes into:
 *
 *   - assistant reply (`AssistantBlock`)
 *   - assistant thinking fold (`AssistantBlock`)
 *   - Analyze & Explain output (`ToolDetailView` AnalyzeSection)
 *   - Analyze & Explain thinking fold
 *
 * Design rules (so bug-fixes have a single blast radius):
 *
 *   - **Typography cascades from the parent.** Callers wrap in a
 *     `<div className="font-sans text-soft-white text-[13px]">` (or
 *     mono / slate-gray for thinking) and the Markdown component
 *     inherits. We don't add font / color / size overrides on
 *     paragraphs, lists, etc. — that lets one component serve every
 *     tone without a `variant` prop matrix.
 *   - **Element-level styling only.** Spacing between blocks, list
 *     bullets, link colors, blockquote rail, table chrome. The visual
 *     identity of *which surface* is set by the parent.
 *   - **Fenced code → `<CodeBlock>`.** Same chevron + label + line
 *     count + copy + auto-fold as the drill-in's primary source
 *     block. Keeps the design language unified.
 *   - **No raw HTML.** `react-markdown` v9 disallows raw HTML by
 *     default — we never enable `rehype-raw`. Means model output
 *     can't inject `<script>` or `<style>` tags even if a user
 *     pastes a malicious snippet into the prompt.
 *   - **Streaming-friendly.** Re-renders cheaply on each chunk. Partial
 *     markdown (unclosed fences, dangling `**`) renders as literal
 *     text until the close arrives — visible self-healing rather
 *     than crash.
 */
import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

interface Props {
  source: string;
  /** When true, reveal `source` character-by-character via rAF so
   *  chunky LLM streams (sentence/paragraph bursts) feel like typing.
   *  Snaps to full `source` the moment `streaming` flips to false. */
  streaming?: boolean;
}

/**
 * Throttled progressive reveal. The hook returns a slice of `source`
 * that grows toward `source.length` on each animation frame.
 *
 * Rate: `max(2, remaining/30)` chars/frame.
 *   - ~120 chars/sec when caught up — reads as "fast typing" without
 *     being painful to wait through.
 *   - Scales up when the cursor is far behind so a 500-char paragraph
 *     dump catches up in <1s instead of dragging for 4s.
 *
 * The cursor persists across re-renders via `useRef`, so chunk
 * arrivals that re-trigger the effect pick up where the previous
 * tick left off — no restart-from-zero stutter.
 */
function useTypewriter(source: string, streaming: boolean): string {
  const [displayed, setDisplayed] = useState(source);
  const cursorRef = useRef(source.length);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Stream ended → snap to full, cancel any pending tick.
    if (!streaming) {
      cursorRef.current = source.length;
      setDisplayed(source);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // Source got shorter (e.g. swapped to a different message) →
    // snap to the new length so we don't display stale chars past
    // the end of the new source.
    if (cursorRef.current > source.length) {
      cursorRef.current = source.length;
      setDisplayed(source);
    }

    const tick = () => {
      if (cursorRef.current >= source.length) {
        rafRef.current = null;
        return;
      }
      const remaining = source.length - cursorRef.current;
      const charsThisFrame = Math.max(2, Math.ceil(remaining / 30));
      cursorRef.current = Math.min(source.length, cursorRef.current + charsThisFrame);
      setDisplayed(source.slice(0, cursorRef.current));
      rafRef.current = requestAnimationFrame(tick);
    };

    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [source, streaming]);

  return displayed;
}

/**
 * Element renderers. We override only what needs to look different
 * from the browser default — paragraphs (need spacing), lists (need
 * bullets back, Tailwind preflight strips them), code (chrome), links
 * (target + brand color), blockquote (rail), tables (chrome).
 *
 * Headings inherit `font-bold` semantics — size cascades from the
 * parent so a heading inside `text-[13px]` body stays in proportion.
 */
const components: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="font-bold text-[1.25em] mt-4 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-bold text-[1.15em] mt-4 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-bold text-[1.05em] mt-3 mb-1.5 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="font-bold mt-3 mb-1.5 first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="font-semibold mt-2 mb-1 first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="font-semibold mt-2 mb-1 first:mt-0 text-slate-gray">
      {children}
    </h6>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
  hr: () => <hr className="my-4 border-0 border-t border-[#2a2a35]" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-[#2a2a35] pl-3 my-3 italic text-slate-gray">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-slate-gray/40 underline-offset-2 text-[#8db4d4] hover:text-soft-white transition-colors"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto custom-scrollbar">
      <table className="border-collapse w-full text-[0.92em]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-[#2a2a35]/40 last:border-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1.5 font-semibold text-left text-slate-gray uppercase tracking-wider text-[0.85em]">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2 py-1.5 align-top">{children}</td>,

  // Code rendering branches on whether we're inside a `<pre>` block.
  // `react-markdown` passes a `className` like `language-js` on the
  // `code` element for fenced blocks; inline code has none. We detect
  // via the `className` prefix — the cleanest signal across MD AST and
  // the only one that survives partial-fence streaming reliably.
  code: ({ className, children, ...rest }) => {
    const match = /^language-([\w-]+)/.exec(className ?? '');
    if (match) {
      const lang = match[1]!;
      // `pyric*` tags are metadata blocks (the suggestion JSON spec).
      // The parser already strips them from the rendered text post-
      // stream, but defense-in-depth: if a stray block slips through
      // (model emitted a variant tag, parser missed it, etc.), hide
      // it from the user rather than rendering the JSON as code.
      if (/^pyric/i.test(lang)) return null;
      const text = String(children ?? '').replace(/\n$/, '');
      return <CodeBlock code={text} language={lang.toUpperCase()} />;
    }
    return (
      <code
        className="font-mono text-[0.9em] bg-[#2a2a35]/60 rounded px-1 py-0.5 text-[#e0b489] break-words"
        {...rest}
      >
        {children}
      </code>
    );
  },
  // `react-markdown` wraps fenced code in `<pre><code>`. The `code`
  // handler already returns a `<CodeBlock>` (its own bordered panel),
  // so the outer `<pre>` would double-wrap visually. Replace it with
  // a margin-only `<div>` so the code block sits with symmetric
  // breathing room above and below (`mb-3` paragraphs flow into
  // `my-5` here, margin collapse keeps the gap at 20px on both sides
  // — paragraphs above and below don't visually crowd the panel).
  pre: ({ children }) => <div className="my-5">{children}</div>,
};

/**
 * Memoized: markdown parsing is the expensive leaf of the message
 * feed. Without memo, ANY page-root re-render re-parses every message
 * on screen — the seconds-per-keystroke typing latency on long
 * sessions. Props are two primitives, so the default shallow compare
 * is exact.
 */
export const Markdown = memo(function Markdown({ source, streaming = false }: Props) {
  const visible = useTypewriter(source, streaming);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {visible}
    </ReactMarkdown>
  );
});
