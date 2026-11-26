/**
 * Chess rules: move generation with castling, en passant and promotion, check,
 * checkmate and stalemate. Pure and synchronous, shared by the browser and the
 * rules test.
 *
 * Squares are 0..63, a8 = 0 through h1 = 63 (row 0 is rank 8), matching how
 * the board is drawn. Pieces are two-letter codes: color ('w' | 'b') then
 * kind ('p' | 'n' | 'b' | 'r' | 'q' | 'k').
 */

export type Color = 'w' | 'b';
export type Kind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Piece = `${Color}${Kind}`;
export type Board = (Piece | '')[];

export interface Position {
  board: Board;
  turn: Color;
  /** Castling rights still available: any of 'K', 'Q', 'k', 'q'. */
  castling: string;
  /** The square a pawn skipped over on the last move, or -1. */
  enPassant: number;
}

export interface Move {
  from: number;
  to: number;
  /** Promotion piece kind, for a pawn reaching the last rank. */
  promotion?: Exclude<Kind, 'p' | 'k'>;
}

export const FILES = 'abcdefgh';

export function squareName(sq: number): string {
  return `${FILES[sq % 8]}${8 - Math.floor(sq / 8)}`;
}

export function squareOf(name: string): number {
  return (8 - Number(name[1])) * 8 + FILES.indexOf(name[0]);
}

const BACK: Kind[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

export function initialPosition(): Position {
  const board: Board = Array(64).fill('');
  for (let f = 0; f < 8; f++) {
    board[f] = `b${BACK[f]}`;
    board[8 + f] = 'bp';
    board[48 + f] = 'wp';
    board[56 + f] = `w${BACK[f]}`;
  }
  return { board, turn: 'w', castling: 'KQkq', enPassant: -1 };
}

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const row = (sq: number) => Math.floor(sq / 8);
const col = (sq: number) => sq % 8;
const on = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ROOK = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

/** Whether `by` attacks `sq` on `board`. */
export function attacked(board: Board, sq: number, by: Color): boolean {
  const r = row(sq);
  const c = col(sq);
  const at = (rr: number, cc: number) => (on(rr, cc) ? board[rr * 8 + cc] : '');
  const pawnRow = by === 'w' ? r + 1 : r - 1;
  if (at(pawnRow, c - 1) === `${by}p` || at(pawnRow, c + 1) === `${by}p`) return true;
  for (const [dr, dc] of KNIGHT) if (at(r + dr, c + dc) === `${by}n`) return true;
  for (const [dr, dc] of KING) if (at(r + dr, c + dc) === `${by}k`) return true;
  const ray = (dirs: number[][], kinds: Kind[]) => {
    for (const [dr, dc] of dirs) {
      for (let k = 1; k < 8; k++) {
        const p = at(r + dr * k, c + dc * k);
        if (!on(r + dr * k, c + dc * k)) break;
        if (p === '') continue;
        if (p[0] === by && kinds.includes(p[1] as Kind)) return true;
        break;
      }
    }
    return false;
  };
  return ray(ROOK, ['r', 'q']) || ray(BISHOP, ['b', 'q']);
}

export function inCheck(pos: Position, color: Color = pos.turn): boolean {
  const king = pos.board.indexOf(`${color}k`);
  return king >= 0 && attacked(pos.board, king, other(color));
}

/** Moves that follow piece movement, before removing those that leave the king in check. */
function pseudoMoves(pos: Position): Move[] {
  const { board, turn } = pos;
  const moves: Move[] = [];
  const add = (from: number, to: number) => {
    const p = board[from];
    if (p[1] === 'p' && (row(to) === 0 || row(to) === 7)) {
      for (const promotion of ['q', 'r', 'b', 'n'] as const) moves.push({ from, to, promotion });
    } else moves.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (p === '' || p[0] !== turn) continue;
    const r = row(from);
    const c = col(from);
    const kind = p[1] as Kind;
    const target = (rr: number, cc: number) => (on(rr, cc) ? board[rr * 8 + cc] : null);
    if (kind === 'p') {
      const dir = turn === 'w' ? -1 : 1;
      const start = turn === 'w' ? 6 : 1;
      if (target(r + dir, c) === '') {
        add(from, (r + dir) * 8 + c);
        if (r === start && target(r + 2 * dir, c) === '') add(from, (r + 2 * dir) * 8 + c);
      }
      for (const dc of [-1, 1]) {
        const t = target(r + dir, c + dc);
        const to = (r + dir) * 8 + c + dc;
        if (t === null) continue;
        if ((t !== '' && t[0] !== turn) || to === pos.enPassant) add(from, to);
      }
    } else if (kind === 'n' || kind === 'k') {
      for (const [dr, dc] of kind === 'n' ? KNIGHT : KING) {
        const t = target(r + dr, c + dc);
        if (t !== null && (t === '' || t[0] !== turn)) add(from, (r + dr) * 8 + c + dc);
      }
    } else {
      const dirs = kind === 'r' ? ROOK : kind === 'b' ? BISHOP : [...ROOK, ...BISHOP];
      for (const [dr, dc] of dirs) {
        for (let k = 1; k < 8; k++) {
          const t = target(r + dr * k, c + dc * k);
          if (t === null) break;
          if (t === '' || t[0] !== turn) add(from, (r + dr * k) * 8 + c + dc * k);
          if (t !== '') break;
        }
      }
    }
  }
  // Castling: rights held, squares between empty, king not in, through, or into check.
  const home = turn === 'w' ? 60 : 4;
  if (board[home] === `${turn}k` && !attacked(board, home, other(turn))) {
    const [kingSide, queenSide] = turn === 'w' ? ['K', 'Q'] : ['k', 'q'];
    if (pos.castling.includes(kingSide) && board[home + 1] === '' && board[home + 2] === '' && board[home + 3] === `${turn}r`
      && !attacked(board, home + 1, other(turn)) && !attacked(board, home + 2, other(turn))) {
      moves.push({ from: home, to: home + 2 });
    }
    if (pos.castling.includes(queenSide) && board[home - 1] === '' && board[home - 2] === '' && board[home - 3] === ''
      && board[home - 4] === `${turn}r` && !attacked(board, home - 1, other(turn)) && !attacked(board, home - 2, other(turn))) {
      moves.push({ from: home, to: home - 2 });
    }
  }
  return moves;
}

/** The position after `move`, without checking that it's legal. */
export function applyMove(pos: Position, move: Move): Position {
  const board = pos.board.slice();
  const piece = board[move.from] as Piece;
  const color = piece[0] as Color;
  const kind = piece[1] as Kind;
  board[move.from] = '';
  if (kind === 'p' && move.to === pos.enPassant) board[move.to + (color === 'w' ? 8 : -8)] = '';
  board[move.to] = move.promotion ? `${color}${move.promotion}` : piece;
  if (kind === 'k' && Math.abs(move.to - move.from) === 2) {
    const kingSide = move.to > move.from;
    const rookFrom = kingSide ? move.from + 3 : move.from - 4;
    const rookTo = kingSide ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = '';
  }
  let castling = pos.castling;
  const drop = (flags: string) => { for (const f of flags) castling = castling.replace(f, ''); };
  if (kind === 'k') drop(color === 'w' ? 'KQ' : 'kq');
  for (const sq of [move.from, move.to]) {
    if (sq === 63) drop('K');
    if (sq === 56) drop('Q');
    if (sq === 7) drop('k');
    if (sq === 0) drop('q');
  }
  const enPassant = kind === 'p' && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : -1;
  return { board, turn: other(color), castling, enPassant };
}

export function legalMoves(pos: Position): Move[] {
  return pseudoMoves(pos).filter((m) => !inCheck(applyMove(pos, m), pos.turn));
}

export function isLegal(pos: Position, move: Move): boolean {
  return legalMoves(pos).some((m) => m.from === move.from && m.to === move.to && (m.promotion ?? '') === (move.promotion ?? ''));
}

export type Outcome = 'playing' | 'checkmate' | 'stalemate';

export function outcome(pos: Position): Outcome {
  if (legalMoves(pos).length > 0) return 'playing';
  return inCheck(pos) ? 'checkmate' : 'stalemate';
}
