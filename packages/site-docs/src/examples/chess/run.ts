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
