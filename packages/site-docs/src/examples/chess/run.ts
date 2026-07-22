import type { PyricExampleContext } from '../definition';

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
export const SQUARES = FILES.flatMap((file) => RANKS.map((rank) => `${file}${rank}`));

export type ChessGame = Record<string, unknown>;

const POSITION_FIELDS = [
  'hp_R1', 'hp_N1', 'hp_B1', 'hp_Q', 'hp_K', 'hp_B2', 'hp_N2', 'hp_R2',
  'hp_P1', 'hp_P2', 'hp_P3', 'hp_P4', 'hp_P5', 'hp_P6', 'hp_P7', 'hp_P8',
  'gp_r1', 'gp_n1', 'gp_b1', 'gp_q', 'gp_k', 'gp_b2', 'gp_n2', 'gp_r2',
  'gp_p1', 'gp_p2', 'gp_p3', 'gp_p4', 'gp_p5', 'gp_p6', 'gp_p7', 'gp_p8',
] as const;

const HOME_PIECES = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];

export function createChessGame(): ChessGame {
  const game: ChessGame = {};
  for (const square of SQUARES) game[square] = '';
  for (const field of POSITION_FIELDS) game[field] = '';

  FILES.forEach((file, index) => {
    game[`${file}1`] = HOME_PIECES[index];
    game[`${file}2`] = 'P';
    game[`${file}7`] = 'p';
    game[`${file}8`] = HOME_PIECES[index]!.toLowerCase();
  });

  const whiteBack = ['hp_R1', 'hp_N1', 'hp_B1', 'hp_Q', 'hp_K', 'hp_B2', 'hp_N2', 'hp_R2'];
  const blackBack = ['gp_r1', 'gp_n1', 'gp_b1', 'gp_q', 'gp_k', 'gp_b2', 'gp_n2', 'gp_r2'];
  FILES.forEach((file, index) => {
    game[whiteBack[index]!] = `${file}1`;
    game[`hp_P${index + 1}`] = `${file}2`;
    game[`gp_p${index + 1}`] = `${file}7`;
    game[blackBack[index]!] = `${file}8`;
  });

  return {
    ...game,
    host: 'white',
    guest: 'black',
    status: 'playing',
    currentTurn: 'host',
    moveCount: 0,
    moveFrom: '',
    moveTo: '',
    movedPiece: '',
    capturedPiece: '',
    moveType: '',
    promotedTo: '',
    lastDoublePawn: '',
    hp_K_moved: false,
    hp_R1_moved: false,
    hp_R2_moved: false,
    gp_k_moved: false,
    gp_r1_moved: false,
    gp_r2_moved: false,
  };
}

export function createEmptyChessGame(): ChessGame {
  const game = createChessGame();
  for (const square of SQUARES) game[square] = '';
  for (const field of POSITION_FIELDS) game[field] = '';
  return game;
}

function positionFieldAt(game: ChessGame, square: string): string {
  return POSITION_FIELDS.find((field) => game[field] === square) ?? '';
}

function rank(square: string): number {
  return Number(square[1]);
}

type Side = 'white' | 'black';
type BoardMove = { from: string; to: string; enPassant?: string };

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const;
const KING_STEPS = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]] as const;
const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function squareAt(file: number, rank: number): string | null {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
  return `${FILES[file]}${rank}`;
}

function coordinates(square: string): [number, number] {
  return [FILES.indexOf(square[0] as typeof FILES[number]), rank(square)];
}

function sideOf(piece: string): Side | null {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? 'white' : 'black';
}

function attacksSquare(game: ChessGame, from: string, target: string): boolean {
  const piece = String(game[from] ?? '');
  const [file, pieceRank] = coordinates(from);
  const [targetFile, targetRank] = coordinates(target);
  const fileDelta = targetFile - file;
  const rankDelta = targetRank - pieceRank;
  const kind = piece.toLowerCase();

  if (kind === 'p') {
    const direction = sideOf(piece) === 'white' ? 1 : -1;
    return rankDelta === direction && Math.abs(fileDelta) === 1;
  }
  if (kind === 'n') return KNIGHT_STEPS.some(([df, dr]) => df === fileDelta && dr === rankDelta);
  if (kind === 'k') return Math.max(Math.abs(fileDelta), Math.abs(rankDelta)) === 1;

  const diagonal = Math.abs(fileDelta) === Math.abs(rankDelta);
  const straight = fileDelta === 0 || rankDelta === 0;
  if ((kind === 'b' && !diagonal) || (kind === 'r' && !straight) || (kind === 'q' && !diagonal && !straight)) return false;

  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);
  let currentFile = file + fileStep;
  let currentRank = pieceRank + rankStep;
  while (currentFile !== targetFile || currentRank !== targetRank) {
    const square = squareAt(currentFile, currentRank);
    if (!square || game[square]) return false;
    currentFile += fileStep;
    currentRank += rankStep;
  }
  return true;
}

export function isInCheck(game: ChessGame, side: Side): boolean {
  const king = String(game[side === 'white' ? 'hp_K' : 'gp_k'] ?? '');
  if (!king) return false;
  return SQUARES.some((square) => {
    const attacker = sideOf(String(game[square] ?? ''));
    return attacker !== null && attacker !== side && attacksSquare(game, square, king);
  });
}

function pseudoLegalMoves(game: ChessGame, side: Side): BoardMove[] {
  const moves: BoardMove[] = [];
  const add = (from: string, to: string | null) => {
    if (!to) return;
    const targetSide = sideOf(String(game[to] ?? ''));
    if (targetSide !== side && String(game[to] ?? '').toLowerCase() !== 'k') moves.push({ from, to });
  };

  for (const from of SQUARES) {
    const piece = String(game[from] ?? '');
    if (sideOf(piece) !== side) continue;
    const kind = piece.toLowerCase();
    const [file, pieceRank] = coordinates(from);

    if (kind === 'p') {
      const direction = side === 'white' ? 1 : -1;
      const one = squareAt(file, pieceRank + direction);
      if (one && !game[one]) {
        moves.push({ from, to: one });
        const homeRank = side === 'white' ? 2 : 7;
        const two = squareAt(file, pieceRank + direction * 2);
        if (pieceRank === homeRank && two && !game[two]) moves.push({ from, to: two });
      }
      for (const fileStep of [-1, 1]) {
        const to = squareAt(file + fileStep, pieceRank + direction);
        if (to && sideOf(String(game[to] ?? '')) === (side === 'white' ? 'black' : 'white')) add(from, to);
      }
      const enPassantTo = String(game.lastDoublePawn ?? '');
      if (enPassantTo) {
        const [targetFile, targetRank] = coordinates(enPassantTo);
        const captured = squareAt(targetFile, pieceRank);
        const expectedPawn = side === 'white' ? 'p' : 'P';
        if (targetRank === pieceRank + direction
          && Math.abs(targetFile - file) === 1
          && captured
          && game[captured] === expectedPawn) {
          moves.push({ from, to: enPassantTo, enPassant: captured });
        }
      }
      continue;
    }

    if (kind === 'n' || kind === 'k') {
      const steps = kind === 'n' ? KNIGHT_STEPS : KING_STEPS;
      for (const [df, dr] of steps) add(from, squareAt(file + df, pieceRank + dr));
      continue;
    }

    const directions = kind === 'b' ? DIAGONAL : kind === 'r' ? ORTHOGONAL : [...DIAGONAL, ...ORTHOGONAL];
    for (const [df, dr] of directions) {
      for (let distance = 1; distance < 8; distance += 1) {
        const to = squareAt(file + df * distance, pieceRank + dr * distance);
        if (!to) break;
        const occupied = Boolean(game[to]);
        add(from, to);
        if (occupied) break;
      }
    }
  }
  return moves;
}

function boardAfter(game: ChessGame, move: BoardMove): ChessGame {
  const next = { ...game, [move.from]: '', [move.to]: game[move.from] };
  if (move.enPassant) next[move.enPassant] = '';
  const kingField = sideOf(String(game[move.from])) === 'white' ? 'hp_K' : 'gp_k';
  if (String(game[move.from]).toLowerCase() === 'k') next[kingField] = move.to;
  return next;
}

export function isCheckmate(game: ChessGame, side: Side): boolean {
  return isInCheck(game, side)
    && !pseudoLegalMoves(game, side).some((move) => !isInCheck(boardAfter(game, move), side));
}

export function checkmateWinner(game: ChessGame): Side | null {
  const sideToMove: Side = game.currentTurn === 'host' ? 'white' : 'black';
  if (!isCheckmate(game, sideToMove)) return null;
  return sideToMove === 'white' ? 'black' : 'white';
}

/** Build the complete Firestore document a client proposes; Rules make the decision. */
export function proposeMove(game: ChessGame, from: string, to: string): ChessGame {
  const piece = String(game[from] ?? '');
  if (!piece) throw new Error(`There is no piece on ${from}.`);
  if (!SQUARES.includes(to)) throw new Error(`${to} is not on the board.`);

  const movedPiece = positionFieldAt(game, from);
  if (!movedPiece) throw new Error(`The position field for ${from} is missing.`);
  const capturedPiece = positionFieldAt(game, to);
  const target = String(game[to] ?? '');
  const pawn = piece === 'P' || piece === 'p';
  const distance = Math.abs(rank(to) - rank(from));
  const moveType = pawn
    ? target ? 'pawn_capture' : distance === 2 ? 'double_pawn' : 'pawn_forward'
    : target ? 'capture' : 'normal';

  const next: ChessGame = {
    ...game,
    [from]: '',
    [to]: piece,
    [movedPiece]: to,
    currentTurn: game.currentTurn === 'host' ? 'guest' : 'host',
    moveCount: Number(game.moveCount) + 1,
    moveFrom: from,
    moveTo: to,
    movedPiece,
    capturedPiece,
    moveType,
    promotedTo: '',
    lastDoublePawn: moveType === 'double_pawn'
      ? `${from[0]}${(rank(from) + rank(to)) / 2}`
      : '',
  };
  if (capturedPiece) next[capturedPiece] = '';
  if (movedPiece.endsWith('_K') || movedPiece.endsWith('_k')) next[`${movedPiece}_moved`] = true;
  if (/_(R|r)[12]$/.test(movedPiece)) next[`${movedPiece}_moved`] = true;
  return next;
}

export async function run({ sandbox }: PyricExampleContext) {
  return {
    backend: 'fresh in-memory sandbox',
    game: 'chess-v2/demo',
    ruleEngine: 'Firestore Security Rules',
  };
}
