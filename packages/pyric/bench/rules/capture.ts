#!/usr/bin/env bun
/**
 * Writes the rules benchmark fixtures under ./fixtures.
 *
 *   bun bench/rules/capture.ts chess
 *   bun bench/rules/capture.ts corpus
 *   bun bench/rules/capture.ts arcade --games /path/to/pyric-games
 *
 * Each fixture records where its rules and requests came from in its
 * `source` field. The arcade capture reads a local pyric-games checkout and
 * never writes to it. Run the harness after a capture to confirm every
 * request still gets the verdict the fixture records.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dir;
const FIXTURES = join(HERE, 'fixtures');
const REPO = resolve(HERE, '../../../..');

type Data = Record<string, unknown>;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function repoCommit(): string {
  const out = spawnSync('git', ['log', '-1', '--format=%h'], { cwd: REPO, encoding: 'utf8' });
  return out.stdout.trim();
}

function fileCommit(repo: string, file: string): string {
  const out = spawnSync('git', ['log', '-1', '--format=%h', '--', file], { cwd: repo, encoding: 'utf8' });
  return out.stdout.trim();
}

/** A stored server timestamp, tagged so the harness revives it as a Timestamp. */
const CREATED_AT = { $timestamp: '2026-09-01T12:00:00.000Z' };

function firestoreTestCase(
  label: string,
  uid: string,
  path: string,
  before: Data,
  after: Data,
): Data {
  return {
    description: label,
    expectation: 'ALLOW',
    method: 'update',
    path,
    auth: { uid },
    resource: before,
    data: after,
  };
}

// ─── Chess showcase ─────────────────────────────────────────────────────

async function captureChess(): Promise<void> {
  const example = join(REPO, 'packages/site-docs/src/examples/chess');
  const dir = join(FIXTURES, 'chess');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(example, 'chess-v2.rules'), join(dir, 'chess-v2.rules'));
  copyFileSync(join(example, 'chess-v2-config.json'), join(dir, 'chess-v2-config.json'));

  const run = await import(join(example, 'run.ts')) as {
    createChessGame(): Data;
    proposeMove(game: Data, from: string, to: string): Data;
  };
  const { CHESS_SCENARIOS } = await import(join(example, 'scenarios.ts')) as {
    CHESS_SCENARIOS: readonly { id: string; moves: readonly { player: string; from: string; to: string }[] }[];
  };
  const scenario = (id: string) => CHESS_SCENARIOS.find((s) => s.id === id)!;

  /** The game before move `index` of a scenario, and that move's proposal. */
  const at = (id: string, index: number) => {
    let game = run.createChessGame();
    const moves = scenario(id).moves;
    for (let i = 0; i < index; i++) game = run.proposeMove(game, moves[i]!.from, moves[i]!.to);
    const move = moves[index]!;
    return { before: game, after: run.proposeMove(game, move.from, move.to), uid: move.player };
  };

  // A normal move: Ruy López, move 3, knight g1 to f3.
  const normal = at('ruy-lopez', 2);
  // A capture: Scholar's Mate, move 7, queen h5 takes f7 (and mates).
  const capture = at('scholars-mate', 6);
  // A castle: Ruy López, then black a7 to a6, then white castles kingside.
  // The showcase scenarios carry no castle, so this one is built here with
  // the same proposeMove the showcase uses, then marked castle_k with the
  // rook moved beside the king.
  let castleBefore = run.createChessGame();
  for (const move of scenario('ruy-lopez').moves) castleBefore = run.proposeMove(castleBefore, move.from, move.to);
  castleBefore = run.proposeMove(castleBefore, 'a7', 'a6');
  const castleAfter: Data = {
    ...run.proposeMove(castleBefore, 'e1', 'g1'),
    moveType: 'castle_k',
    h1: '',
    f1: 'R',
    hp_R2: 'f1',
    hp_R2_moved: true,
  };

  const path = 'chess-v2/demo';
  const request = (label: string, uid: string, before: Data, after: Data) => ({
    label,
    expect: 'ALLOW',
    testCase: firestoreTestCase(label, uid, path, before, after),
    e2e: { uid, via: 'setDoc', reset: { [path]: before }, ops: [{ type: 'set', path, data: after }] },
  });

  writeJson(join(dir, 'fixture.json'), {
    id: 'chess',
    service: 'firestore',
    source: {
      repo: 'pyric',
      commit: repoCommit(),
      rules: 'packages/site-docs/src/examples/chess/chess-v2.rules (2+modules, resolved by the harness)',
      config: 'packages/site-docs/src/examples/chess/chess-v2-config.json',
      requests: 'packages/site-docs/src/examples/chess/scenarios.ts through run.ts proposeMove: ruy-lopez move 3 (normal), scholars-mate move 7 (capture); the castle is ruy-lopez plus a7-a6 plus e1-g1 marked castle_k, built in capture.ts',
    },
    rules: { file: 'chess-v2.rules', modules: true },
    docs: { 'gameConfig/chessv2': { $file: 'chess-v2-config.json' } },
    requests: [
      request('normal move (Nf3)', normal.uid, normal.before, normal.after),
      request('capture (Qxf7#)', capture.uid, capture.before, capture.after),
      request('castle (O-O)', 'white', castleBefore, castleAfter),
    ],
  });
  console.log(`wrote ${dir}`);
}

// ─── Arcade (pyric-games) ───────────────────────────────────────────────

async function captureArcade(games: string): Promise<void> {
  const app = (file: string) => join(games, 'app', file);
  const src = (game: string, file: string) => join(games, 'games', game, 'src', file);

  // Firestore: Reversi move and Yacht score.
  {
    const dir = join(FIXTURES, 'arcade-firestore');
    mkdirSync(dir, { recursive: true });
    copyFileSync(app('firestore.rules'), join(dir, 'firestore.rules'));
    const transitions = await import(join(games, 'packages/turn-net/src/transitions.ts'));
    const reversiLogic = await import(src('reversi', 'logic.ts'));
    const reversiBoard = await import(src('reversi', 'reversi.ts'));

    const reversiPath = reversiLogic.matchPath('bench');
    const created = transitions.createdMatch(reversiLogic.reversi, 'host-uid');
    const joined = { ...transitions.joinedMatch(created, 'guest-uid'), createdAt: CREATED_AT };
    const first = reversiBoard.legalMoves(reversiLogic.positionOf(joined.board, 'host'))[0];
    const reversiOps = reversiLogic.moveOps('bench', joined, first) as { type: string; path: string; data: Data }[];
    if (reversiOps.length !== 1 || reversiOps[0]!.type !== 'update') throw new Error('expected one Reversi update');

    const yacht = await import(src('yacht', 'logic.ts'));
    const yachtPath = yacht.matchPath('bench');
    const salt = '0123456789abcdef0123456789abcdef';
    let m = yacht.createdMatch('player-0');
    m = yacht.afterJoin(m, 'player-1');
    m = yacht.afterStart(m);
    m = yacht.afterCommit(m, yacht.commitmentOf(salt), [false, false, false, false, false]);
    m = yacht.afterNonce(m, 1, 'fedcba9876543210fedcba9876543210');
    m = yacht.afterReveal(m, salt);
    const yachtBefore = { ...m, createdAt: CREATED_AT };
    const category = yacht.bestCategory(m);
    const yachtOps = yacht.scoreOps('bench', m, category) as { type: string; path: string; data: Data }[];

    const request = (label: string, uid: string, path: string, before: Data, ops: { type: string; path: string; data: Data }[]) => ({
      label,
      expect: 'ALLOW',
      testCase: firestoreTestCase(label, uid, path, before, { ...before, ...ops[0]!.data }),
      e2e: { uid, via: 'batch', reset: { [path]: before }, ops },
    });

    writeJson(join(dir, 'fixture.json'), {
      id: 'arcade-firestore',
      service: 'firestore',
      source: {
        repo: 'davideast/arcade (local checkout pyric-games)',
        rulesCommit: fileCommit(games, 'app/firestore.rules'),
        rules: 'app/firestore.rules (resolved from app/firestore.modules.rules by the arcade)',
        requests: `Reversi: games/reversi/src/logic.ts moveOps for the first legal move after create and join, as games/reversi/src/rules.test.ts plays it. Yacht: games/yacht/src/logic.ts scoreOps(${category}) after one commit, nonce and reveal, as games/yacht/src/rules.test.ts plays it.`,
      },
      rules: { file: 'firestore.rules' },
      docs: {},
      requests: [
        request('Reversi move', 'host-uid', reversiPath, joined, reversiOps),
        request(`Yacht score (${category})`, 'player-0', yachtPath, yachtBefore, yachtOps),
      ],
    });
    console.log(`wrote ${dir}`);
  }

  // RTDB: one Air Hockey frame.
  {
    const dir = join(FIXTURES, 'arcade-rtdb');
    mkdirSync(dir, { recursive: true });
    copyFileSync(app('database.rules.json'), join(dir, 'database.rules.json'));
    const logic = await import(src('air-hockey', 'logic.ts'));
    const physics = await import(src('air-hockey', 'physics.ts'));
    const world = { ...physics.initialWorld(), tick: 1 };
    const stored = logic.frameOf(world);
    const next = logic.frameOf({ ...world, tick: 2 });
    const op = logic.frameOp('m1', 'host-uid', { ...world, tick: 2 }, false) as { type: string; path: string; value: unknown };
    const tree = {
      airhockey: {
        m1: {
          'host-uid': {
            meta: { guest: 'guest-uid', status: 'playing', winner: '' },
            frame: stored,
            score: { host: 0, guest: 0 },
            presence: { host: true, guest: true },
          },
        },
      },
    };
    const path = `/${op.path}`;
    writeJson(join(dir, 'fixture.json'), {
      id: 'arcade-rtdb',
      service: 'rtdb',
      source: {
        repo: 'davideast/arcade (local checkout pyric-games)',
        rulesCommit: fileCommit(games, 'app/database.rules.json'),
        rules: 'app/database.rules.json',
        requests: 'games/air-hockey/src/logic.ts frameOp (a set of one frame) over the playing tree games/air-hockey/src/rtdb-rules.test.ts uses',
      },
      rules: { file: 'database.rules.json' },
      requests: [{
        label: 'Air Hockey frame',
        expect: 'ALLOW',
        input: { operation: 'write', path, auth: { uid: 'host-uid', token: {} }, mockData: tree, newData: next },
        e2e: { uid: 'host-uid', op: op.type, path: op.path, value: next, tree, tick: 'puck.t' },
      }],
    });
    console.log(`wrote ${dir}`);
  }

  // Storage: one Sokoban upload, with the score document it reads.
  {
    const dir = join(FIXTURES, 'arcade-storage');
    mkdirSync(dir, { recursive: true });
    copyFileSync(app('storage.rules'), join(dir, 'storage.rules'));
    const logic = await import(src('sokoban', 'logic.ts'));
    const { SOLUTIONS } = await import(src('sokoban', 'solutions.ts'));
    const level = '1';
    const writes = logic.solveWrites('alice-uid', level, 'Solve000000000000000', SOLUTIONS[level]);
    const score = { ...writes.score.data, createdAt: CREATED_AT };
    const bytes = new TextEncoder().encode(writes.upload.text).byteLength;
    writeJson(join(dir, 'fixture.json'), {
      id: 'arcade-storage',
      service: 'storage',
      source: {
        repo: 'davideast/arcade (local checkout pyric-games)',
        rulesCommit: fileCommit(games, 'app/storage.rules'),
        rules: 'app/storage.rules',
        requests: 'games/sokoban/src/logic.ts solveWrites for level 1 with the stored solution, as games/sokoban/src/rules.test.ts uploads it',
      },
      rules: { file: 'storage.rules' },
      firestoreDocs: { [writes.score.path]: score },
      requests: [{
        label: 'Sokoban upload',
        expect: 'ALLOW',
        input: {
          request: {
            auth: { uid: 'alice-uid' },
            method: 'create',
            path: `/b/demo-pyric.appspot.com/o/${writes.upload.path}`,
            resource: {
              size: bytes,
              contentType: writes.upload.contentType,
              metadata: writes.upload.customMetadata,
              name: writes.upload.path,
              bucket: 'demo-pyric.appspot.com',
            },
          },
          resource: null,
        },
        e2e: { uid: 'alice-uid', ...writes.upload },
      }],
    });
    console.log(`wrote ${dir}`);
  }
}

// ─── Conformance corpus ─────────────────────────────────────────────────

const CORPUS = {
  firestore: [
    'common-auth-membership-firestore',
    'required-fields-and-mapdiff',
    'hierarchical-match-cascade',
    'list-and-string-methods',
  ],
  storage: ['common-auth-membership', 'metadata-access', 'upload-primitives-boundaries'],
  rtdb: ['r2-own-uid', 'r4-validate-structure', 'r14-root-lookup'],
} as const;

const RTDB_UID = 'bench-uid';

function substituteUid<T>(value: T, uid: string): T {
  if (typeof value === 'string') return value.replaceAll('<UID>', uid) as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Data).map(([k, v]) => [k, substituteUid(v, uid)]),
    ) as unknown as T;
  }
  return value;
}

function setAt(root: Data, path: string, value: unknown): void {
  const segments = path.split('/').filter(Boolean);
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const existing = cursor[segments[i]!];
    const child = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Data : {};
    cursor[segments[i]!] = child;
    cursor = child;
  }
  if (segments.length > 0) cursor[segments[segments.length - 1]!] = value;
}

/** The first case the corpus records as allowed, else the first case. */
function representative<T extends { expectation: string; operation?: string }>(cases: readonly T[]): T {
  return cases.find((c) => c.expectation === 'ALLOW' && c.operation !== 'update') ?? cases[0]!;
}

async function captureCorpus(): Promise<void> {
  const corpus = join(REPO, 'packages/conformance/rules-corpus');
  const { ALL_RULES_FIRESTORE_SCENARIOS } = await import(join(corpus, 'firestore/index.ts'));
  const { ALL_RULES_STORAGE_SCENARIOS } = await import(join(corpus, 'storage/index.ts'));
  const { ALL_RULES_RTDB_SCENARIOS } = await import(join(corpus, 'rtdb/index.ts'));
  const { normalizeStoragePath } = await import(join(REPO, 'packages/pyric/src/rules/test/spec.ts'));
  const commit = repoCommit();
  const scenarios: Data[] = [];

  for (const id of CORPUS.firestore) {
    const s = ALL_RULES_FIRESTORE_SCENARIOS.find((x: { id: string }) => x.id === id);
    const tc = representative(s.cases as { expectation: string }[]) as Data;
    scenarios.push({ id: `firestore/${id}`, service: 'firestore', rules: s.rules, label: tc.description, expect: tc.expectation, testCase: tc });
  }
  for (const id of CORPUS.storage) {
    const s = ALL_RULES_STORAGE_SCENARIOS.find((x: { id: string }) => x.id === id);
    const tc = representative(s.cases as { expectation: string }[]) as unknown as Data & {
      path: string; bucket?: string; auth?: unknown; method: string;
      resource?: Data; existingResource?: Data; requestTime?: string;
      functionMocks?: { function: string; path: string; result: unknown }[];
    };
    const request: Data = { auth: tc.auth ?? null, method: tc.method, path: normalizeStoragePath(tc.path, tc.bucket) };
    if (tc.resource) request.resource = { size: tc.resource.size ?? 0, contentType: tc.resource.contentType, metadata: tc.resource.metadata };
    const gets: Data = {};
    const exists: string[] = [];
    for (const mock of tc.functionMocks ?? []) {
      if (mock.function === 'get' && mock.result && typeof mock.result === 'object') gets[mock.path] = mock.result;
      else if (mock.function === 'exists' && mock.result === true) exists.push(mock.path);
    }
    scenarios.push({
      id: `storage/${id}`,
      service: 'storage',
      rules: s.rules,
      label: tc.description,
      expect: tc.expectation,
      input: { request, resource: tc.existingResource ?? null },
      ...(tc.requestTime ? { now: tc.requestTime } : {}),
      lookup: { gets, exists },
    });
  }
  for (const id of CORPUS.rtdb) {
    const s = ALL_RULES_RTDB_SCENARIOS.find((x: { id: string }) => x.id === id);
    const tc = representative(s.cases as { expectation: string; operation: string }[]) as unknown as Data & {
      operation: string; opPath: string; authPresent: boolean; newData?: unknown; mockData?: unknown; seed?: Data;
    };
    const uid = tc.authPresent ? RTDB_UID : '';
    const path = `/${id}${substituteUid(tc.opPath, uid)}`;
    const tree: Data = {};
    for (const [seedPath, seedValue] of Object.entries(tc.seed ?? {})) {
      setAt(tree, `/${id}${substituteUid(seedPath, uid)}`, substituteUid(seedValue, uid));
    }
    if (tc.mockData !== undefined && tc.mockData !== null) setAt(tree, path, substituteUid(tc.mockData, uid));
    scenarios.push({
      id: `rtdb/${id}`,
      service: 'rtdb',
      rules: JSON.stringify({ rules: { '.read': false, '.write': false, [id]: JSON.parse(s.rules) } }),
      label: tc.description,
      expect: tc.expectation,
      input: {
        operation: tc.operation,
        path,
        auth: tc.authPresent ? { uid, token: { firebase: { sign_in_provider: 'anonymous' }, provider_id: 'anonymous' } } : null,
        mockData: tree,
        ...(tc.newData !== undefined ? { newData: substituteUid(tc.newData, uid) } : {}),
      },
    });
  }

  const dir = join(FIXTURES, 'corpus');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'fixture.json'), {
    id: 'corpus',
    service: 'mixed',
    source: {
      repo: 'pyric',
      commit,
      scenarios: 'packages/conformance/rules-corpus/{firestore,storage,rtdb}; one case per scenario, the first the corpus records as allowed',
    },
    scenarios,
  });
  console.log(`wrote ${dir}`);
}

// ─── Entry ──────────────────────────────────────────────────────────────

const [what] = process.argv.slice(2);
if (what === 'chess') await captureChess();
else if (what === 'corpus') await captureCorpus();
else if (what === 'arcade') {
  const at = process.argv.indexOf('--games');
  const games = at > 0 ? process.argv[at + 1] : undefined;
  if (!games) throw new Error('pass --games <path to a pyric-games checkout>');
  await captureArcade(resolve(games));
} else {
  console.error('usage: bun bench/rules/capture.ts chess | corpus | arcade --games <path>');
  process.exitCode = 2;
}
