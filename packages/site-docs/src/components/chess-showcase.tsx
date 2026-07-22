import { useRef, useState } from 'react';
import {
  createChessSession,
  type ChessSession,
  type ChessVerdict,
} from '../examples/chess/session';
import { ChessBoard } from './chess-board';
import { ChessControls } from './chess-controls';
import { RulesVerdict } from './rules-verdict';

export function ChessShowcase() {
  const session = useRef<ChessSession>(createChessSession());
  const [game, setGame] = useState(() => session.current.game());
  const [uid, setUid] = useState<'white' | 'black'>('white');
  const [selected, setSelected] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ChessVerdict | null>(null);
  const [moving, setMoving] = useState(false);
  const [winner, setWinner] = useState<'white' | 'black' | null>(null);

  const move = async (from: string, to: string) => {
    setMoving(true);
    try {
      const nextVerdict = await session.current.move(uid, from, to);
      setVerdict(nextVerdict);
      setGame(session.current.game());
      setWinner(nextVerdict.checkmate);
    } catch (error) {
      setVerdict({
        allowed: false,
        uid,
        write: `${from} → ${to}`,
        detail: error instanceof Error ? error.message : String(error),
        checkmate: null,
      });
    } finally {
      setSelected(null);
      setMoving(false);
    }
  };

  const playFoolsMate = async () => {
    setMoving(true);
    setSelected(null);
    try {
      const moves = [
        ['white', 'f2', 'f3'],
        ['black', 'e7', 'e5'],
        ['white', 'g2', 'g4'],
        ['black', 'd8', 'h4'],
      ] as const;
      for (const [player, from, to] of moves) {
        const nextVerdict = await session.current.move(player, from, to);
        setVerdict(nextVerdict);
        setGame(session.current.game());
        if (!nextVerdict.allowed) break;
        setWinner(nextVerdict.checkmate);
      }
    } finally {
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
    setWinner(null);
  };

  return (
    <main className="chess-showcase">
      <section className="chess-play" aria-label="Playable chess demonstration">
        <ChessBoard game={game} selected={selected} disabled={moving || winner !== null} onSelect={selectSquare} />

        <aside className="chess-console">
          <ChessControls
            game={game}
            uid={uid}
            moving={moving}
            winner={winner}
            onIdentity={setUid}
            onMove={(from, to) => void move(from, to)}
            onCheckmate={() => void playFoolsMate()}
            onReset={reset}
          />
          <RulesVerdict verdict={verdict} />
        </aside>
      </section>
    </main>
  );
}
