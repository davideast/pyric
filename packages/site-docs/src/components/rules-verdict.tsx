import type { ChessVerdict } from '../examples/chess/session';

interface Props { verdict: ChessVerdict | null }

export function RulesVerdict({ verdict }: Props) {
  return (
    <div className={`verdict ${verdict ? verdict.allowed ? 'is-allowed' : 'is-denied' : ''}`} aria-live="polite">
      <span className="console-label">Rules verdict</span>
      {verdict ? (
        <>
          <strong><i aria-hidden="true" />{verdict.allowed ? 'Allowed' : 'Denied'} · {verdict.write}</strong>
          <dl>
            <div><dt>Auth UID</dt><dd><code>{verdict.uid}</code></dd></div>
            <div><dt>Document</dt><dd><code>chess-v2/demo</code></dd></div>
          </dl>
          <p>{verdict.detail}</p>
        </>
      ) : (
        <p>Select a piece and a destination, or try one of the prepared writes.</p>
      )}
    </div>
  );
}
