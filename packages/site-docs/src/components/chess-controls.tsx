import type { ChessGame } from '../examples/chess/run';

interface Props {
  game: ChessGame;
  uid: 'white' | 'black';
  moving: boolean;
  winner: 'white' | 'black' | null;
  onIdentity(uid: 'white' | 'black'): void;
  onMove(from: string, to: string): void;
  onCheckmate(): void;
  onReset(): void;
}

function turnLabel(game: ChessGame): string {
  return game.currentTurn === 'host' ? 'White' : 'Black';
}

export function ChessControls({ game, uid, moving, winner, onIdentity, onMove, onCheckmate, onReset }: Props) {
  const initialPosition = Number(game.moveCount) === 0;
  return (
    <>
      <div className="turn-row">
        <div>
          <span className="console-label">Rules expect</span>
          <strong>{winner ? `${winner === 'white' ? 'White' : 'Black'} wins by checkmate` : `${turnLabel(game)} to move`}</strong>
        </div>
        <button type="button" className="reset-button" onClick={onReset}>Reset board</button>
      </div>

      <fieldset className="identity-picker">
        <legend>Send the write as</legend>
        <button type="button" aria-pressed={uid === 'white'} onClick={() => onIdentity('white')}>White <code>white</code></button>
        <button type="button" aria-pressed={uid === 'black'} onClick={() => onIdentity('black')}>Black <code>black</code></button>
      </fieldset>

      <div className="try-row">
        <button type="button" disabled={!initialPosition || moving || winner !== null} onClick={() => onMove('e2', 'e4')}>Try legal e2 → e4</button>
        <button type="button" disabled={!initialPosition || moving || winner !== null} onClick={() => onMove('e2', 'e5')}>Try illegal e2 → e5</button>
        <button type="button" className="checkmate-button" disabled={!initialPosition || moving || winner !== null} onClick={onCheckmate}>Play Fool’s Mate</button>
      </div>
    </>
  );
}
