import { FILES, RANKS, type ChessGame } from '../examples/chess/run';

const PIECES: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

interface Props {
  game: ChessGame;
  selected: string | null;
  disabled: boolean;
  onSelect(square: string): void;
}

export function ChessBoard({ game, selected, disabled, onSelect }: Props) {
  const files = [...FILES];
  const ranks = [...RANKS].reverse();

  return (
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
              disabled={disabled}
              onClick={() => onSelect(square)}
            >
              <span className="chess-piece" aria-hidden="true">{PIECES[piece] ?? ''}</span>
              {fileIndex === 0 ? <small className="rank-label">{rank}</small> : null}
              {rankIndex === 7 ? <small className="file-label">{file}</small> : null}
            </button>
          );
        }))}
      </div>
    </div>
  );
}
