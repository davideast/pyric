/**
 * Rulesets and requests whose production evaluation cost the expression-cost
 * capture measures (`capture-rules-expression-cost.ts`).
 *
 * Three suites:
 *  - `ladder`: synthetic match blocks, one expression shape each, repeated a
 *    known number of times so a total divides into a per-shape cost.
 *  - `chess`: the resolved chess showcase ruleset from
 *    `packages/site-docs/src/examples/chess`, with moves replayed from its
 *    scenarios plus a castle, an en passant capture and a promotion.
 *  - `arcade`: an externally authored resolved ruleset (the arcade repository's
 *    `app/firestore.rules`), read from `PYRIC_ARCADE_RULES` when set.
 *
 * Each case names the match block that the capture injects its padding rule
 * into (`padAnchor`, the exact `match ... {` header text) and the method the
 * padding rule grants, so the padding is evaluated in the same request.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestCase } from '../../pyric/src/rules/test/spec.ts';
import { resolveModulesBrowser } from '../../pyric/src/rules/modules/resolver-browser.ts';
import {
  createChessGame,
  createEmptyChessGame,
  proposeMove,
  type ChessGame,
} from '../../site-docs/src/examples/chess/run.ts';
import { CHESS_SCENARIOS } from '../../site-docs/src/examples/chess/scenarios.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');

export interface ExpressionCostCase {
  id: string;
  /** Exact `match ... {` header of the block the request resolves to. */
  padAnchor: string;
  /** True when the rules fix the evaluated path for every document, so a
   *  static estimate can match production exactly. False when the path
   *  depends on document or request values the estimate cannot see. */
  pathFixed: boolean;
  testCase: TestCase;
}

export interface ExpressionCostSuite {
  id: string;
  description: string;
  rules: string;
  /** Documents the cases read with get(), keyed by document path. The capture
   *  sends each as a function mock and records its source file and digest. */
  documents: Record<string, { file: string; data: Record<string, unknown> }>;
  cases: ExpressionCostCase[];
}

// ─── Ladder ───────────────────────────────────────────────────────────────

interface LadderShape {
  id: string;
  description: string;
  /** Functions the block declares, in source form. */
  functions?: string;
  /** The allow conditions of the block, in order. */
  conditions: string[];
  /** The evaluated path depends on values: a short-circuit the rules alone do not decide. */
  dataDependent?: boolean;
  resource?: Record<string, unknown>;
  mocks?: TestCase['functionMocks'];
}

const REPEAT = 20;
const repeat = (term: (j: number) => string, op: '&&' | '||', n = REPEAT) =>
  Array.from({ length: n }, (_, j) => term(j)).join(` ${op} `);

const LADDER_SHAPES: LadderShape[] = [
  { id: 'eq-field', description: `${REPEAT} conjuncts \`resource.data.a == 1\``, conditions: [repeat(() => 'resource.data.a == 1', '&&')] },
  { id: 'eq-wildcard', description: `${REPEAT} conjuncts \`id == 'x'\``, conditions: [repeat(() => "id == 'x'", '&&')] },
  { id: 'literal-true', description: `${REPEAT} conjuncts \`true\``, conditions: [repeat(() => 'true', '&&')] },
  {
    id: 'parameter',
    description: `a function returning ${REPEAT} conjuncts of its boolean parameter`,
    functions: `function allOf(b) { return ${repeat(() => 'b', '&&')}; }`,
    conditions: ['allOf(true)'],
  },
  {
    id: 'call',
    description: `${REPEAT} conjuncts \`g(id)\`, g(x) returning \`x == 'x'\``,
    functions: "function g(x) { return x == 'x'; }",
    conditions: [repeat(() => 'g(id)', '&&')],
  },
  {
    id: 'let',
    description: `${REPEAT} conjuncts \`lt(id)\`, lt(x) binding \`let v = x\` and returning \`v == 'x'\``,
    functions: "function lt(x) { let v = x; return v == 'x'; }",
    conditions: [repeat(() => 'lt(id)', '&&')],
  },
  {
    id: 'let-unused',
    description: 'a let bound to 10 comparisons whose value the short-circuited return never reads',
    functions: `function lu() { let v = ${repeat(() => 'resource.data.a == 1', '&&', 10)}; return id == 'y' && v; }`,
    conditions: ['!lu()'],
  },
  { id: 'in-list', description: `${REPEAT} conjuncts \`id in ['x', 'y']\``, conditions: [repeat(() => "id in ['x', 'y']", '&&')] },
  { id: 'method', description: `${REPEAT} conjuncts \`resource.data.keys().size() > 0\``, conditions: [repeat(() => 'resource.data.keys().size() > 0', '&&')] },
  {
    id: 'bracket',
    description: `${REPEAT} conjuncts \`r[f] == 1\` with r and f parameters`,
    functions: `function at(r, f) { return ${repeat(() => 'r[f] == 1', '&&')}; }`,
    conditions: ["at(resource.data, 'a')"],
  },
  { id: 'slice', description: `${REPEAT} conjuncts \`id[0:1] == 'x'\``, conditions: [repeat(() => "id[0:1] == 'x'", '&&')] },
  { id: 'not', description: `${REPEAT} conjuncts \`!(id == 'y')\``, conditions: [repeat(() => "!(id == 'y')", '&&')] },
  { id: 'ternary', description: `${REPEAT} conjuncts \`(id == 'x' ? true : false)\``, conditions: [repeat(() => "(id == 'x' ? true : false)", '&&')] },
  { id: 'map-eq', description: `${REPEAT / 2} conjuncts \`resource.data.m == {'k': 1}\``, conditions: [repeat(() => "resource.data.m == {'k': 1}", '&&', REPEAT / 2)] },
  { id: 'or-false', description: `${REPEAT} disjuncts, only the last true`, conditions: [repeat((j) => (j === REPEAT - 1 ? "id == 'x'" : "id == 'y'"), '||')] },
  { id: 'and-short-circuit', description: `a false first conjunct before ${REPEAT - 1} more`, conditions: ['!(' + repeat((j) => (j === 0 ? "id == 'y'" : 'resource.data.a == 1'), '&&') + ')'], dataDependent: true },
  { id: 'or-short-circuit', description: `a true first disjunct before ${REPEAT - 1} more`, conditions: [repeat((j) => (j === 0 ? "id == 'x'" : 'resource.data.a == 1'), '||')], dataDependent: true },
  {
    id: 'get-cached',
    description: '5 conjuncts reading the same document with get()',
    conditions: [repeat(() => 'get(/databases/$(database)/documents/cfg/c).data.on == true', '&&', 5)],
    mocks: [{ function: 'get', path: 'cfg/c', result: { on: true } }],
  },
  // Operands after an error: `resource.data.missing` errors, and production
  // goes on evaluating the other operands, which count.
  { id: 'error-eq', description: `${REPEAT} conjuncts \`resource.data.missing == resource.data.a\``, conditions: [repeat(() => 'resource.data.missing == resource.data.a', '&&')] },
  { id: 'error-plus', description: `${REPEAT} conjuncts \`resource.data.missing + resource.data.a == 1\``, conditions: [repeat(() => 'resource.data.missing + resource.data.a == 1', '&&')] },
  { id: 'error-list', description: `${REPEAT} conjuncts \`[resource.data.missing, resource.data.a] == []\``, conditions: [repeat(() => '[resource.data.missing, resource.data.a] == []', '&&')] },
  { id: 'error-map', description: `${REPEAT / 2} conjuncts \`{'k': resource.data.missing, 'j': resource.data.a} == {}\``, conditions: [repeat(() => "{'k': resource.data.missing, 'j': resource.data.a} == {}", '&&', REPEAT / 2)] },
  { id: 'error-in', description: `${REPEAT} conjuncts \`resource.data.missing in [resource.data.a, 2]\``, conditions: [repeat(() => 'resource.data.missing in [resource.data.a, 2]', '&&')] },
  { id: 'error-method-args', description: `${REPEAT} conjuncts \`resource.data.get(resource.data.missing, resource.data.a) == 1\``, conditions: [repeat(() => 'resource.data.get(resource.data.missing, resource.data.a) == 1', '&&')] },
  { id: 'error-receiver', description: `${REPEAT} conjuncts \`resource.data.missing.get('k', resource.data.a) == 1\``, conditions: [repeat(() => "resource.data.missing.get('k', resource.data.a) == 1", '&&')] },
  { id: 'error-namespace-args', description: `${REPEAT} conjuncts \`math.pow(resource.data.missing, resource.data.a) == 1.0\``, conditions: [repeat(() => 'math.pow(resource.data.missing, resource.data.a) == 1.0', '&&')] },
  {
    id: 'error-call-args',
    description: `${REPEAT} conjuncts \`ig(resource.data.missing, resource.data.a)\`, ig(x, y) returning true`,
    functions: 'function ig(x, y) { return true; }',
    conditions: [repeat(() => 'ig(resource.data.missing, resource.data.a)', '&&')],
  },
  {
    id: 'error-let',
    description: `${REPEAT} conjuncts \`el()\`, el() binding \`let v = resource.data.missing\` and returning true`,
    functions: 'function el() { let v = resource.data.missing; return true; }',
    conditions: [repeat(() => 'el()', '&&')],
  },
  {
    id: 'rule-order',
    description: `three allow rules of ${REPEAT} conjuncts each; the first two end false`,
    conditions: [
      repeat((j) => (j === REPEAT - 1 ? "id == 'y'" : 'resource.data.a == 1'), '&&'),
      repeat((j) => (j === REPEAT - 1 ? "id == 'y'" : 'resource.data.a == 1'), '&&'),
      repeat(() => 'resource.data.a == 1', '&&'),
    ],
  },
];

function ladderSuite(): ExpressionCostSuite {
  const blocks = LADDER_SHAPES.map((shape) => {
    const header = `match /${shape.id}/{id} {`;
    const body = [
      ...(shape.functions ? [`      ${shape.functions}`] : []),
      ...shape.conditions.map((c) => `      allow get: if ${c};`),
    ];
    return { shape, header, text: `    ${header}\n${body.join('\n')}\n    }` };
  });
  const rules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    ...blocks.map((b) => b.text),
    '  }',
    '}',
    '',
  ].join('\n');
  return {
    id: 'ladder',
    description: 'Synthetic match blocks, one expression shape each.',
    rules,
    documents: {},
    cases: blocks.map(({ shape, header }) => ({
      id: `ladder/${shape.id}`,
      padAnchor: header,
      pathFixed: !shape.dataDependent,
      testCase: {
        description: shape.description,
        expectation: 'ALLOW',
        method: 'get',
        path: `${shape.id}/x`,
        auth: { uid: 'u' },
        resource: shape.resource ?? { a: 1, m: { k: 1 } },
        ...(shape.mocks ? { functionMocks: shape.mocks } : {}),
      },
    })),
  };
}

// ─── Chess ────────────────────────────────────────────────────────────────

const CHESS_DIR = join(REPO_ROOT, 'packages', 'site-docs', 'src', 'examples', 'chess');
const CHESS_CONFIG_FILE = 'packages/site-docs/src/examples/chess/chess-v2-config.json';
const CHESS_ANCHOR = 'match /chess-v2/{gameId} {';

function chessRules(): string {
  const authored = readFileSync(join(CHESS_DIR, 'chess-v2.rules'), 'utf8');
  const resolution = resolveModulesBrowser(authored);
  if (!resolution.success) throw new Error(`chess rules did not resolve: ${resolution.error.message}`);
  return resolution.data.resolved;
}

function moveCase(id: string, description: string, before: ChessGame, after: ChessGame, expectation: 'ALLOW' | 'DENY'): ExpressionCostCase {
  const uid = before.currentTurn === 'host' ? String(before.host) : String(before.guest);
  return {
    id: `chess/${id}`,
    padAnchor: CHESS_ANCHOR,
    pathFixed: false,
    testCase: {
      description,
      expectation,
      method: 'update',
      path: 'chess-v2/demo',
      auth: { uid },
      resource: before,
      data: after,
      functionMocks: [{ function: 'get', path: 'gameConfig/chessv2', result: {} }],
    },
  };
}

function replay(moves: readonly { from: string; to: string }[], start = createChessGame()): ChessGame[] {
  const states = [start];
  for (const move of moves) states.push(proposeMove(states[states.length - 1]!, move.from, move.to));
  return states;
}

function chessCases(): ExpressionCostCase[] {
  const scenario = (id: string) => CHESS_SCENARIOS.find((s) => s.id === id)!;
  const cases: ExpressionCostCase[] = [];
  const pick = (scenarioId: string, index: number, id: string, description: string) => {
    const states = replay(scenario(scenarioId).moves);
    cases.push(moveCase(id, description, states[index]!, states[index + 1]!, 'ALLOW'));
  };
  pick('fools-mate', 0, 'pawn-forward', 'White pawn f2 to f3 (pawn_forward).');
  pick('ruy-lopez', 0, 'pawn-double', 'White pawn e2 to e4 (double_pawn).');
  pick('ruy-lopez', 2, 'knight', 'White knight g1 to f3 (normal).');
  pick('ruy-lopez', 4, 'bishop', 'White bishop f1 to b5 (normal, sliding path).');
  pick('fools-mate', 3, 'queen-mate', 'Black queen d8 to h4, checkmate (normal).');
  pick('scholars-mate', 6, 'queen-capture', 'White queen h5 takes f7, checkmate (capture).');
  const leap = replay(scenario('illegal-pawn-leap').moves);
  cases.push(moveCase('illegal-leap', 'White pawn e2 to e5 is denied.', leap[0]!, leap[1]!, 'DENY'));

  // Castle: Ruy Lopez, then a7-a6, then White castles kingside.
  const ruy = replay([...scenario('ruy-lopez').moves, { from: 'a7', to: 'a6' }]);
  const beforeCastle = ruy[ruy.length - 1]!;
  const castle = proposeMove(beforeCastle, 'e1', 'g1');
  Object.assign(castle, { moveType: 'castle_k', h1: '', f1: 'R', hp_R2: 'f1', hp_R2_moved: true });
  cases.push(moveCase('castle-kingside', 'White castles kingside (castle_k).', beforeCastle, castle, 'ALLOW'));

  // En passant: e4, a6, e5, d5, then e5 takes d6 en passant.
  const ep = replay([
    { from: 'e2', to: 'e4' }, { from: 'a7', to: 'a6' }, { from: 'e4', to: 'e5' }, { from: 'd7', to: 'd5' },
  ]);
  const beforeEp = ep[ep.length - 1]!;
  const enPassant = proposeMove(beforeEp, 'e5', 'd6');
  Object.assign(enPassant, { moveType: 'en_passant', capturedPiece: 'gp_p4', gp_p4: '', d5: '' });
  cases.push(moveCase('en-passant', 'White pawn e5 takes d6 en passant (en_passant).', beforeEp, enPassant, 'ALLOW'));

  // Promotion: kings on e1 and e8, a White pawn on b7 promotes on b8.
  const beforePromo = createEmptyChessGame();
  Object.assign(beforePromo, { e1: 'K', hp_K: 'e1', e8: 'k', gp_k: 'e8', b7: 'P', hp_P2: 'b7' });
  const promotion = proposeMove(beforePromo, 'b7', 'b8');
  Object.assign(promotion, { moveType: 'promotion', promotedTo: 'Q', b8: 'Q' });
  cases.push(moveCase('promotion', 'White pawn b7 promotes to a queen on b8 (promotion).', beforePromo, promotion, 'ALLOW'));
  return cases;
}

function chessSuite(): ExpressionCostSuite {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, CHESS_CONFIG_FILE), 'utf8')) as Record<string, unknown>;
  return {
    id: 'chess',
    description: 'The resolved chess showcase ruleset with replayed and constructed moves.',
    rules: chessRules(),
    documents: { 'gameConfig/chessv2': { file: CHESS_CONFIG_FILE, data: config } },
    cases: chessCases(),
  };
}

// ─── Arcade ───────────────────────────────────────────────────────────────

function ticTacToe(board: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    host: 'host-uid', guest: 'guest-uid', currentTurn: 'host', status: 'playing', winner: '', moveCount: 0,
    lastMove: '', createdAt: '2026-01-01T00:00:00Z', board, ...extra,
  };
}

const CELLS = ['c0r0', 'c1r0', 'c2r0', 'c0r1', 'c1r1', 'c2r1', 'c0r2', 'c1r2', 'c2r2'];
const emptyBoard = () => Object.fromEntries(CELLS.map((c) => [c, '']));

function chessBoard(): Record<string, string> {
  const board: Record<string, string> = {};
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  'abcdefgh'.split('').forEach((file, i) => {
    board[`${file}1`] = `w${back[i]}`; board[`${file}2`] = 'wp';
    for (const rank of [3, 4, 5, 6]) board[`${file}${rank}`] = '';
    board[`${file}7`] = 'bp'; board[`${file}8`] = `b${back[i]}`;
  });
  return board;
}

/** A reversi board keyed by row and column digits ('11' to '88'). */
function reversiBoard(pieces: Record<string, 'd' | 'l'>): Record<string, string> {
  const board: Record<string, string> = {};
  for (let row = 1; row <= 8; row++) for (let col = 1; col <= 8; col++) board[`${row}${col}`] = '';
  return { ...board, ...pieces };
}

/**
 * A reversi move by the host ('d') at `at`, flipping every listed square.
 * `runs` gives the flips per direction in the rules' order:
 * +1, +11, +10, +9, -1, -11, -10, -9.
 */
function reversiMove(before: Record<string, 'd' | 'l'>, at: string, flips: string[], runs: number[]) {
  const board = reversiBoard(before);
  const after = { ...board, [at]: 'd', ...Object.fromEntries(flips.map((sq) => [sq, 'd'])) };
  const count = (b: Record<string, string>, piece: string) => Object.values(b).filter((v) => v === piece).length;
  const base = {
    host: 'host-uid', guest: 'guest-uid', status: 'playing', winner: '', createdAt: '2026-01-01T00:00:00Z',
  };
  const resource = {
    ...base, currentTurn: 'host', moveCount: 0, board, prevBoard: board,
    lastMove: { at: '', runs: [] }, counts: { d: count(board, 'd'), l: count(board, 'l') },
  };
  const data = {
    ...base, currentTurn: 'guest', moveCount: 1, board: after, prevBoard: board,
    lastMove: { at, runs }, counts: { d: count(after, 'd'), l: count(after, 'l') },
  };
  return { resource, data };
}

function arcadeCases(): ExpressionCostCase[] {
  const moveBefore = ticTacToe(emptyBoard());
  const moveAfter = ticTacToe({ ...emptyBoard(), c1r1: 'host' }, { currentTurn: 'guest', moveCount: 1, lastMove: 'c1r1' });
  const winBoard = { ...emptyBoard(), c0r0: 'host', c1r0: 'host', c0r1: 'guest', c1r1: 'guest' };
  const winBefore = ticTacToe(winBoard, { moveCount: 4 });
  const winAfter = ticTacToe({ ...winBoard, c2r0: 'host' }, { currentTurn: 'guest', moveCount: 5, lastMove: 'c2r0', status: 'won', winner: 'host' });
  const start = chessBoard();
  const chessBefore = {
    host: 'host-uid', guest: 'guest-uid', currentTurn: 'host', status: 'playing', winner: '', moveCount: 0,
    board: start, castling: 'KQkq', enPassant: '', prevBoard: start, prevCastling: 'KQkq', prevEnPassant: '',
    lastMove: { from: '', to: '', promotion: '', extra: [] }, createdAt: '2026-01-01T00:00:00Z',
  };
  const chessAfter = {
    ...chessBefore, board: { ...start, e2: '', e4: 'wp' }, enPassant: 'e3', prevBoard: start,
    lastMove: { from: 'e2', to: 'e4', promotion: '', extra: [] }, currentTurn: 'guest', moveCount: 1,
  };
  const update = (id: string, anchor: string, path: string, description: string, uid: string, resource: Record<string, unknown>, data: Record<string, unknown>): ExpressionCostCase => ({
    id: `arcade/${id}`,
    padAnchor: anchor,
    pathFixed: false,
    testCase: { description, expectation: 'ALLOW', method: 'update', path, auth: { uid }, resource, data },
  });
  return [
    update('tictactoe-move', 'match /tictactoe/{matchId} {', 'tictactoe/m1', 'Host places a mark on c1r1.', 'host-uid', moveBefore, moveAfter),
    update('tictactoe-win', 'match /tictactoe/{matchId} {', 'tictactoe/m1', 'Host completes the top row and wins.', 'host-uid', winBefore, winAfter),
    update('chess-e4', 'match /chess/{matchId} {', 'chess/m1', 'White pawn e2 to e4.', 'host-uid', chessBefore, chessAfter),
    update('reversi-opening', 'match /reversi/{matchId} {', 'reversi/m1', 'Host plays 56, flipping 55.', 'host-uid',
      ...reversiPair(reversiMove({ '54': 'd', '55': 'l', '44': 'l', '45': 'd' }, '56', ['55'], [0, 0, 0, 0, 1, 0, 0, 0]))),
    update('reversi-three-rays', 'match /reversi/{matchId} {', 'reversi/m1', 'Host plays 44, flipping two squares along each of three rays.', 'host-uid',
      ...reversiPair(reversiMove(
        { '45': 'l', '46': 'l', '47': 'd', '54': 'l', '64': 'l', '74': 'd', '55': 'l', '66': 'l', '77': 'd' },
        '44', ['45', '46', '54', '64', '55', '66'], [2, 2, 2, 0, 0, 0, 0, 0],
      ))),
  ];
}

function reversiPair(move: { resource: Record<string, unknown>; data: Record<string, unknown> }): [Record<string, unknown>, Record<string, unknown>] {
  return [move.resource, move.data];
}

function arcadeSuite(file: string): ExpressionCostSuite {
  return {
    id: 'arcade',
    description: 'An externally authored resolved ruleset for several turn-based games.',
    rules: readFileSync(file, 'utf8'),
    documents: {},
    cases: arcadeCases(),
  };
}

/** Every suite the capture measures. The arcade suite is included only when
 *  `arcadeRules` names a readable resolved ruleset. */
export function expressionCostSuites(options: { arcadeRules?: string } = {}): ExpressionCostSuite[] {
  const suites = [ladderSuite(), chessSuite()];
  if (options.arcadeRules) suites.push(arcadeSuite(options.arcadeRules));
  return suites;
}
