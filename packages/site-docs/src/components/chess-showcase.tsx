import { useRef, useState } from 'react';
import configSource from '../examples/chess/chess-v2-config.json?raw';
import rulesSource from '../examples/chess/chess-v2.rules?raw';
import runSource from '../examples/chess/run.ts?raw';
import scenariosSource from '../../test/examples/chess/chess.test.ts?raw';
import { FILES, RANKS, type ChessGame } from '../examples/chess/run';
import {
  createChessSession,
  type ChessSession,
  type ChessVerdict,
} from '../examples/chess/session';

const PIECES: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

type SourceTab = 'application' | 'rules' | 'geometry' | 'scenarios';

const SOURCE = {
  application: runSource,
  rules: rulesSource,
  geometry: configSource,
  scenarios: scenariosSource,
} satisfies Record<SourceTab, string>;

function turnLabel(game: ChessGame): string {
  return game.currentTurn === 'host' ? 'White' : 'Black';
}

export function ChessShowcase() {
  const session = useRef<ChessSession>(createChessSession());
  const [game, setGame] = useState(() => session.current.game());
  const [uid, setUid] = useState<'white' | 'black'>('white');
  const [selected, setSelected] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ChessVerdict | null>(null);
  const [moving, setMoving] = useState(false);
  const [sourceTab, setSourceTab] = useState<SourceTab>('application');

  const move = async (from: string, to: string) => {
    setMoving(true);
    try {
      const nextVerdict = await session.current.move(uid, from, to);
      setVerdict(nextVerdict);
      setGame(session.current.game());
    } catch (error) {
      setVerdict({
        allowed: false,
        uid,
        write: `${from} → ${to}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSelected(null);
      setMoving(false);
    }
  };

  const selectSquare = (square: string) => {
    if (moving) return;
    if (selected === null) {
      setSelected(square);
      return;
    }
    if (selected === square) {
      setSelected(null);
      return;
    }
    void move(selected, square);
  };

  const reset = () => {
    session.current = session.current.reset();
    setGame(session.current.game());
    setUid('white');
    setSelected(null);
    setVerdict(null);
  };

  const files = [...FILES];
  const ranks = [...RANKS].reverse();

  return (
    <main className="chess-showcase">
      <header className="chess-hero">
        <p className="chess-kicker">A browser-only Firestore sandbox</p>
        <h1>Chess, with Security Rules as the game engine.</h1>
        <p className="chess-intro">The board sends a Firestore write. Pyric runs the same Rules shape locally and either commits the new position or keeps the board untouched.</p>
        <ul className="chess-proof" aria-label="Showcase evidence">
          <li><strong>17</strong> replayed scenarios</li>
          <li><strong>{session.current.lint.errors}</strong> linter errors</li>
          <li><strong>1</strong> isolated browser sandbox</li>
        </ul>
        <p className="chess-scope">The playable board covers ordinary moves, captures, and pawn moves. The source also shows the artifact's special-move branches.</p>
      </header>

      <section className="chess-play" aria-label="Playable chess demonstration">
        <div className="chess-board-wrap">
          <div className="chess-board" role="grid" aria-label="Chess board">
            {ranks.flatMap((rank, rankIndex) => files.map((file, fileIndex) => {
              const square = `${file}${rank}`;
              const piece = String(game[square] ?? '');
              const dark = (rankIndex + fileIndex) % 2 === 1;
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={square}
                  className={`chess-square ${dark ? 'is-dark' : 'is-light'} ${selected === square ? 'is-selected' : ''}`}
                  aria-label={`${square}${piece ? ` ${piece}` : ' empty'}`}
                  aria-pressed={selected === square}
                  onClick={() => selectSquare(square)}
                >
                  <span aria-hidden="true">{PIECES[piece] ?? ''}</span>
                  {fileIndex === 0 ? <small className="rank-label">{rank}</small> : null}
                  {rankIndex === 7 ? <small className="file-label">{file}</small> : null}
                </button>
              );
            }))}
          </div>
        </div>

        <aside className="chess-console">
          <div className="turn-row">
            <div>
              <span className="console-label">Rules expect</span>
              <strong>{turnLabel(game)} to move</strong>
            </div>
            <button type="button" className="reset-button" onClick={reset}>Reset board</button>
          </div>

          <fieldset className="identity-picker">
            <legend>Send the write as</legend>
            <button type="button" aria-pressed={uid === 'white'} onClick={() => setUid('white')}>White <code>white</code></button>
            <button type="button" aria-pressed={uid === 'black'} onClick={() => setUid('black')}>Black <code>black</code></button>
          </fieldset>

          <div className="try-row">
            <button type="button" disabled={Number(game.moveCount) !== 0} onClick={() => void move('e2', 'e4')}>Try legal e2 → e4</button>
            <button type="button" disabled={Number(game.moveCount) !== 0} onClick={() => void move('e2', 'e5')}>Try illegal e2 → e5</button>
          </div>

          <div className={`verdict ${verdict ? verdict.allowed ? 'is-allowed' : 'is-denied' : ''}`} aria-live="polite">
            <span className="console-label">Rules verdict</span>
            {verdict ? (
              <>
                <strong>{verdict.allowed ? 'Allowed' : 'Denied'} · {verdict.write}</strong>
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
        </aside>
      </section>

      <section className="chess-source" aria-labelledby="source-heading">
        <div className="source-heading-row">
          <div>
            <p className="chess-kicker">One running example</p>
            <h2 id="source-heading">See what the board executes</h2>
          </div>
          <div className="source-tabs" role="tablist" aria-label="Chess source files">
            {(['application', 'rules', 'geometry', 'scenarios'] as const).map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={sourceTab === tab}
                key={tab}
                onClick={() => setSourceTab(tab)}
              >{tab === 'application' ? 'Move builder' : tab === 'rules' ? 'Security Rules' : tab === 'geometry' ? 'Geometry data' : '17 scenarios'}</button>
            ))}
          </div>
        </div>
        <pre role="tabpanel"><code>{SOURCE[sourceTab]}</code></pre>
      </section>
    </main>
  );
}
