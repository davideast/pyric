/**
 * `build_game_rules` — generate a complete Firestore ruleset for a
 * grid-based turn-based game via `assembleGameRules` from
 * `pyric/rules` (the generator the firestore-game-rules skill
 * mandates: win-line enumerations and gravity/integrity checks are too
 * repetitive to hand-write — hand-writing them is an error factory).
 *
 * Registered ONLY while the "Game rules" skill is active (the skill
 * definition contributes it — activation is the gate). The tool
 * RETURNS the rules source; the agent reviews it and writes
 * /workspace/firestore.rules through the normal file flow, so the lint
 * diagnostic block still sees every deploy. No host-side magic.
 *
 * Leaf module: imports only `@inbrowser/agent` types + `pyric/rules`,
 * so the skill registry can reference it without an import cycle
 * through lib/tools/index.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { assembleGameRules, defaultCellName } from 'pyric/rules/internal';

const PRESETS = {
  'tic-tac-toe': { cols: 3, rows: 3, winLength: 3, hasGravity: false },
  'connect-four': { cols: 7, rows: 6, winLength: 4, hasGravity: true },
  gomoku: { cols: 9, rows: 9, winLength: 5, hasGravity: false },
} as const;

/** The documented board range: rows and columns each 1 to 11. */
const MIN_SIDE = 1;
const MAX_SIDE = 11;

export interface BuildGameRulesArgs {
  game: keyof typeof PRESETS | 'custom';
  collection?: string;
  cols?: number;
  rows?: number;
  winLength?: number;
  hasGravity?: boolean;
}

export interface BuildGameRulesData {
  rules: string;
  game: string;
  collection: string;
  cols: number;
  rows: number;
  winLength: number;
  hasGravity: boolean;
  cellCount: number;
  /** Which assembler layout was chosen (>42 cells = flat/MapDiff). */
  optimization: 'classic-nested' | 'flat-mapdiff';
  docShape: string;
}

export const buildGameRulesHandler: ToolHandler<BuildGameRulesArgs, BuildGameRulesData | { reason: string }> = {
  name: 'build_game_rules',
  parallelSafe: true, // pure function of its args
  description:
    'Generate a COMPLETE Firestore ruleset for a grid-based turn-based game (host/guest convention: host/guest UIDs, currentTurn, status waiting|playing|won|draw, moveCount, flat cell fields). Presets: game="tic-tac-toe" (3x3, 3-in-a-row), "connect-four" (7x6, 4-in-a-row, gravity), "gomoku" (9x9, 5-in-a-row); or game="custom" with cols/rows/winLength/hasGravity (cols and rows each 1-11). Win-line enumeration, gravity, board integrity, turn enforcement, and split-allow state transitions (move / host win / guest win / draw) are all generated — NEVER hand-write these. Returns { rules, docShape, ... }: REVIEW the rules, then write them to /workspace/firestore.rules yourself (lint runs on deploy) and create game docs matching docShape. Use `collection` to match your data model (default "games").',
  parameters: {
    type: 'object',
    properties: {
      game: {
        type: 'string',
        enum: ['tic-tac-toe', 'connect-four', 'gomoku', 'custom'],
        description: 'Preset game, or "custom" with explicit grid params.',
      },
      collection: {
        type: 'string',
        description: 'Firestore collection holding game docs (default "games").',
      },
      cols: { type: 'number', description: 'custom only: board columns (1-11)' },
      rows: { type: 'number', description: 'custom only: board rows (1-11)' },
      winLength: { type: 'number', description: 'custom only: N-in-a-row to win' },
      hasGravity: {
        type: 'boolean',
        description: 'custom only: pieces fall to the lowest empty row (Connect-Four style)',
      },
    },
    required: ['game'],
  },
  async execute(args) {
    const preset = args.game !== 'custom' ? PRESETS[args.game] : undefined;
    if (args.game !== 'custom' && !preset) {
      return {
        ok: false,
        summary: `build_game_rules: unknown game "${args.game}"`,
        data: { reason: 'unknown game' },
      };
    }
    const cols = preset?.cols ?? args.cols ?? 0;
    const rows = preset?.rows ?? args.rows ?? 0;
    const winLength = preset?.winLength ?? args.winLength ?? 0;
    const hasGravity = preset?.hasGravity ?? args.hasGravity ?? false;
    const collection = (args.collection ?? 'games').trim() || 'games';

    // Allowlist the collection name (like the bounded-int grid params) before
    // it reaches assembleGameRules, which interpolates it into a
    // `match /<collection>/{gameId}` block. A value with slashes/braces/
    // newlines could inject arbitrary rule blocks. (The generator enforces
    // the same rule as a library-level backstop; we validate here to return a
    // clean tool error instead of a thrown exception.)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(collection)) {
      return {
        ok: false,
        summary: `build_game_rules: invalid collection "${collection}" — use letters, digits, "-" or "_" (1–64 chars)`,
        data: { reason: 'invalid collection' },
      };
    }

    if (!isBoardSide(cols) || !isBoardSide(rows)) {
      return {
        ok: false,
        summary: `build_game_rules: a ${cols}x${rows} board is outside the supported range: cols and rows must each be integers from ${MIN_SIDE} to ${MAX_SIDE}`,
        data: { reason: 'invalid grid' },
      };
    }
    const cellCount = cols * rows;
    if (!Number.isInteger(winLength) || winLength < 2 || winLength > Math.max(cols, rows)) {
      return {
        ok: false,
        summary: `build_game_rules: winLength must be an integer in [2, max(cols, rows)]`,
        data: { reason: 'invalid winLength' },
      };
    }

    let rules: string;
    try {
      rules = assembleGameRules({
        collection,
        grid: { cols, rows, cellName: defaultCellName },
        winLineCount: winLength,
        hasGravity,
        hasLobby: true,
      });
    } catch (error) {
      // The generator refuses rules production would not compile.
      return {
        ok: false,
        summary: `build_game_rules: ${error instanceof Error ? error.message : String(error)}`,
        data: { reason: 'rules exceed production compile limits' },
      };
    }
    const optimization = cellCount > 42 ? 'flat-mapdiff' : 'classic-nested';
    const cellFields = `${defaultCellName(0, 0)}..${defaultCellName(cols - 1, rows - 1)} (each '' | 'host' | 'guest')`;
    const docShape =
      optimization === 'flat-mapdiff'
        ? `{ host, guest, currentTurn: 'host'|'guest', status: 'waiting'|'playing'|'won'|'draw', moveCount: 0, winner: '', lastMove: '', ${cellFields} as TOP-LEVEL fields }`
        : `{ host, guest, currentTurn: 'host'|'guest', status: 'waiting'|'playing'|'won'|'draw', moveCount: 0, winner: '', lastCol: -1, lastRow: -1, board: { ${cellFields} } }`;

    return {
      ok: true,
      summary: `build_game_rules: generated ${args.game} rules (${cols}x${rows}, ${winLength}-in-a-row${hasGravity ? ', gravity' : ''}, ${optimization}) for /${collection}/{gameId} — review, then write to /workspace/firestore.rules`,
      data: {
        rules,
        game: args.game,
        collection,
        cols,
        rows,
        winLength,
        hasGravity,
        cellCount,
        optimization,
        docShape,
      },
    };
  },
};

function isBoardSide(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE;
}
