/**
 * Fixture appSource for the preview-proof spec. Keeps the surface
 * minimal — `useState` hook to prove React mounted, a `data-testid`
 * selector for the assertion, and a button so a follow-up test can
 * extend to interaction. Zero Firebase imports so the test stays
 * decoupled from sandbox seeding.
 *
 * Loaded by the spec as a string, fed into the playground via
 * `window.__pyricTestSeed({ appSource: <this file's text> })`.
 */
import { useState } from 'react';

export default function App() {
  const [clicks, setClicks] = useState(0);
  return (
    <main
      data-testid="preview-proof"
      style={{
        display: 'grid',
        gap: '12px',
        padding: '24px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 data-testid="preview-proof-heading" style={{ fontSize: '20px', margin: 0 }}>
        Preview proof — rendered from /workspace/src/App.tsx
      </h1>
      <p data-testid="preview-proof-count">clicks: {clicks}</p>
      <button
        data-testid="preview-proof-button"
        type="button"
        onClick={() => setClicks((n) => n + 1)}
        style={{
          padding: '8px 16px',
          border: '1px solid #2a2a35',
          borderRadius: '6px',
          background: '#0f0f17',
          color: '#e5e7eb',
        }}
      >
        click me
      </button>
    </main>
  );
}
