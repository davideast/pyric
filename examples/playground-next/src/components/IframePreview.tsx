/**
 * Isolated mount for the user's App component. The component renders
 * inside a same-origin `<iframe>` with its own `document` + own React
 * root, so the playground's Tailwind / inherited styles can't bleed
 * in and the user's CSS can't leak out. DOM, focus, and event
 * delegation stay inside the iframe.
 *
 * Same-origin is intentional: we want to share the React instance
 * (so hooks injected via the compile scope work natively) and we
 * want the user's component closure to keep referencing the
 * playground's live `sandbox` / `db` / sentinels. The closure carries
 * those across the boundary for free — we're isolating presentation,
 * not the data plane.
 *
 * Note about `sandbox=`: we don't set the attribute. Setting
 * `allow-scripts allow-same-origin` together is functionally the same
 * as no attribute and triggers a browser warning. Omitting it gets
 * full same-origin privilege, which is what we need. The user's code
 * already executes via `new Function` in the parent window anyway —
 * iframe isolation here is about presentation, not script trust.
 */
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

interface IframePreviewProps {
  /** The compiled user component. New ref on each source recompile. */
  Component: React.ComponentType;
}

// Modern CSS reset (Andy Bell / Josh Comeau lineage) — strips browser
// defaults so user apps start from a true baseline. Deliberately
// imposes *no* font-family, color, background, font-size, or padding:
// previously the iframe forced Inter + #1a1a22 + 16px padding, which
// fought with apps that wanted their own typography (the agent
// generates serif-typeset slide decks, modernist sans layouts, etc.).
// Apps now declare what they need from a clean slate.
const IFRAME_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  * { margin: 0; }
  html { -webkit-text-size-adjust: 100%; }
  html, body { min-height: 100%; }
  body { line-height: 1.5; -webkit-font-smoothing: antialiased; }
  img, picture, video, canvas, svg { display: block; max-width: 100%; }
  input, button, textarea, select { font: inherit; color: inherit; background: none; border: 0; }
  button { cursor: pointer; }
  p, h1, h2, h3, h4, h5, h6 { overflow-wrap: break-word; }
  ul, ol { list-style: none; padding: 0; }
  a { color: inherit; text-decoration: inherit; }
  #root { min-height: 100%; isolation: isolate; }
</style>
</head>
<body><div id="root"></div></body>
</html>`;

export function IframePreview({ Component }: IframePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const rootRef = useRef<Root | null>(null);

  // Set up the root once on mount. The `load` event fires after
  // `srcDoc` is parsed — at that point `contentDocument` is ready.
  //
  // Both readyState + load-event paths funnel through `handleLoad`,
  // which guards against double-creation: an initial about:blank doc
  // can report `readyState === 'complete'` synchronously (no `<div id="root">`
  // in it, so the early return covers that case), and the actual srcDoc
  // load then fires the event. Without the `rootRef.current` guard a
  // late-firing load event after a fast path would re-`createRoot` on
  // the same node and orphan the prior root.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let cancelled = false;
    const handleLoad = () => {
      if (cancelled) return;
      // A second load event (e.g. after an HMR-driven srcDoc swap)
      // must NOT spawn a second root on the same mount node. The
      // existing root has already rendered the user's component;
      // re-render through the effect-2 path below if `Component`
      // changes. Without this guard the previous root is orphaned
      // and its `useEffect` cleanups never run, leaking observer
      // subscriptions (e.g. `onAuthStateChanged`) into the still-
      // live React tree.
      if (rootRef.current) return;
      const doc = iframe.contentDocument;
      const mount = doc?.getElementById('root');
      if (!doc || !mount) return;
      rootRef.current = createRoot(mount);
      rootRef.current.render(<Component />);
    };

    iframe.addEventListener('load', handleLoad);
    // If the doc was already parsed (HMR'd iframe instance), prime now.
    if (iframe.contentDocument?.readyState === 'complete') {
      handleLoad();
    }

    return () => {
      cancelled = true;
      iframe.removeEventListener('load', handleLoad);
      try {
        rootRef.current?.unmount();
      } catch {
        /* unmount can throw mid-teardown — safe to ignore */
      }
      rootRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render whenever the compiled component identity changes. The
  // iframe's React root is stable; only the rendered tree swaps.
  useEffect(() => {
    rootRef.current?.render(<Component />);
  }, [Component]);

  return (
    <iframe
      ref={iframeRef}
      title="App preview"
      srcDoc={IFRAME_HTML}
      style={{
        border: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        background: '#ffffff',
      }}
    />
  );
}
