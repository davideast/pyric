/**
 * Every game the generator accepts must load in production and evaluate
 * legitimate winning moves within production's 1,000-expression per-request
 * budget (#1425). The documented board range is 1 to 11 rows and columns, with
 * 2 to max(cols, rows) in a row and gravity on or off: 1,650 configs.
 *
 * The boundary configs run on every test run; the full 1,650-config sweep
 * parses every ruleset and runs when PYRIC_GAME_RULES_FULL_SWEEP=1 is set.
 */
import { describe, expect, test } from 'bun:test';
import { assembleGameRules, type GameConfig } from '../../src/generators/assembler.js';
import {
  defaultCellName,
  emptyBoard,
  generateWinLines,
  indexToColRow,
} from '../../src/generators/grid.js';
import { sourceCompileLimitViolations } from '../../src/grammar/source-compile-limits.js';
import { EXPRESSION_LIMIT } from '../../src/linter/expression-cost.js';
import { firestoreRules, type CaseResult, type FirestoreCase } from '../../src/index.js';

const SIDES = Array.from({ length: 11 }, (_, i) => i + 1);
const SMALL_BOARD_THRESHOLD = 42;

function configsFor(cols: number, rows: number): GameConfig[] {
  const configs: GameConfig[] = [];
  for (let winLineCount = 2; winLineCount <= Math.max(cols, rows); winLineCount++) {
    for (const hasGravity of [false, true]) {
      configs.push({
        collection: 'games',
        grid: { cols, rows, cellName: defaultCellName },
        winLineCount,
        hasGravity,
        hasLobby: true,
      });
    }
  }
  return configs;
}

function describeConfig(config: GameConfig): string {
  return `${config.grid.cols}x${config.grid.rows}, ${config.winLineCount} in a row, gravity ${config.hasGravity}`;
}

/** Build a forced winning update case on `line`, placing the final cell at `moveSlot`. */
function buildForcedWinCase(
  config: GameConfig,
  line: readonly number[],
  mark: 'host' | 'guest',
  moveSlot = line.length - 1,
): FirestoreCase {
  const { grid } = config;
  const usesFlat = grid.cols * grid.rows > SMALL_BOARD_THRESHOLD;
  const moveIndex = line[moveSlot] ?? 0;
  const [lastCol, lastRow] = indexToColRow(moveIndex, grid.cols);
  const lastMoveName = grid.cellName(lastCol, lastRow);
  const beforeCells = emptyBoard(grid);
  for (let i = 0; i < line.length; i++) {
    if (i === moveSlot) continue;
    const idx = line[i];
    if (idx === undefined) continue;
    const [c, r] = indexToColRow(idx, grid.cols);
    beforeCells[grid.cellName(c, r)] = mark;
  }
  const afterCells = { ...beforeCells, [lastMoveName]: mark };
  const nextTurn = mark === 'host' ? 'guest' : 'host';
  const uid = mark === 'host' ? 'u-host' : 'u-guest';
  const moveCountBefore = line.length * 2 - 1;
  const moveCountAfter = line.length * 2;

  if (usesFlat) {
    return {
      description: `${mark} win on (${lastCol},${lastRow})`,
      expectation: 'ALLOW',
      method: 'update',
      path: 'games/g1',
      auth: { uid },
      resource: {
        host: 'u-host',
        guest: 'u-guest',
        currentTurn: mark,
        status: 'playing',
        moveCount: moveCountBefore,
        winner: '',
        lastMove: grid.cellName(0, 0),
        ...beforeCells,
      },
      data: {
        host: 'u-host',
        guest: 'u-guest',
        currentTurn: nextTurn,
        status: 'won',
        moveCount: moveCountAfter,
        winner: mark,
        lastMove: lastMoveName,
        ...afterCells,
      },
    };
  }

  return {
    description: `${mark} win on (${lastCol},${lastRow})`,
    expectation: 'ALLOW',
    method: 'update',
    path: 'games/g1',
    auth: { uid },
    resource: {
      host: 'u-host',
      guest: 'u-guest',
      currentTurn: mark,
      status: 'playing',
      moveCount: moveCountBefore,
      winner: '',
      lastCol: 0,
      lastRow: 0,
      board: beforeCells,
    },
    data: {
      host: 'u-host',
      guest: 'u-guest',
      currentTurn: nextTurn,
      status: 'won',
      moveCount: moveCountAfter,
      winner: mark,
      lastCol,
      lastRow,
      board: afterCells,
    },
  };
}

const cachedCompileCodes = new Map<string, Set<string>>();
const cachedRulesets = new Map<string, ReturnType<typeof firestoreRules>>();

/** Check compile limits and forced last-line win budget for every config in `configs`. */
function failingConfigs(configs: readonly GameConfig[]): string[] {
  const failing: string[] = [];
  for (const config of configs) {
    let source: string;
    try {
      source = assembleGameRules(config);
    } catch (error) {
      failing.push(`${describeConfig(config)}: refused: ${(error as Error).message}`);
      continue;
    }
    let codes = cachedCompileCodes.get(source);
    if (codes === undefined) {
      codes = new Set(sourceCompileLimitViolations(source).map((v) => v.code));
      cachedCompileCodes.set(source, codes);
    }
    if (codes.size > 0) {
      failing.push(`${describeConfig(config)}: ${[...codes].join(', ')}`);
      continue;
    }
    const lines = generateWinLines(config.grid.cols, config.grid.rows, config.winLineCount);
    const lastLine = lines[lines.length - 1];
    if (lastLine === undefined) continue;
    let ruleset = cachedRulesets.get(source);
    if (ruleset === undefined) {
      ruleset = firestoreRules(source);
      cachedRulesets.set(source, ruleset);
    }
    const summary = ruleset.simulate([
      buildForcedWinCase(config, lastLine, 'host'),
      buildForcedWinCase(config, lastLine, 'guest'),
    ]);
    for (const result of summary.cases) {
      if (result.decision !== 'ALLOW' || result.evaluatedExpressions > EXPRESSION_LIMIT || result.resourceLimit !== undefined) {
        failing.push(
          `${describeConfig(config)} (${result.description}): decision=${result.decision}, exprs=${result.evaluatedExpressions}, limit=${result.resourceLimit?.kind ?? 'none'}`,
        );
      }
    }
  }
  return failing;
}

/** [cols, rows, winLineCount] of the configs whose rules failed NESTING_DEPTH on main, each with gravity off and on. */
const FAILED_ON_MAIN: ReadonlyArray<readonly [number, number, number]> = [
  [4, 9, 2], [4, 10, 2], [5, 7, 2], [5, 8, 2], [6, 6, 2], [6, 7, 2], [6, 7, 3],
  [7, 5, 2], [7, 6, 2], [7, 6, 3], [8, 5, 2], [9, 4, 2], [10, 4, 2],
  [10, 11, 2], [11, 10, 2], [11, 11, 2], [11, 11, 3],
];

/** Boundary boards covering nested and flat layouts, including large boards that exceeded 1,000 expressions (#1425). */
const BUDGET_BOUNDARY_BOARDS: ReadonlyArray<readonly [number, number, number, boolean]> = [
  [3, 3, 3, false],
  [3, 8, 2, false],
  [4, 6, 2, true],
  [7, 6, 4, true],
  [7, 11, 2, false],
  [9, 9, 5, false],
  [10, 10, 4, true],
  [11, 11, 6, false],
  [11, 11, 8, false],
  [11, 11, 11, true],
];

const runFullSweep = process.env.PYRIC_GAME_RULES_FULL_SWEEP === '1';

describe('assembleGameRules output compiles and stays within budget where it failed on main', () => {
  for (const [cols, rows, winLineCount] of FAILED_ON_MAIN) {
    test(`${cols}x${rows}, ${winLineCount} in a row`, () => {
      const configs = configsFor(cols, rows).filter((config) => config.winLineCount === winLineCount);
      expect(configs).toHaveLength(2);
      expect(failingConfigs(configs)).toEqual([]);
    }, 30_000);
  }
});

describe.skipIf(!runFullSweep)('assembleGameRules compiles and stays under 1,000 expressions for every documented config', () => {
  test('the sweep covers 1,650 configs', () => {
    const total = SIDES.flatMap((cols) => SIDES.map((rows) => configsFor(cols, rows).length)).reduce((a, b) => a + b, 0);
    expect(total).toBe(1650);
  });

  for (const cols of SIDES) {
    for (const rows of SIDES) {
      test(`${cols}x${rows}`, () => {
        expect(failingConfigs(configsFor(cols, rows))).toEqual([]);
      }, 90_000);
    }
  }
});

describe('assembleGameRules stays under the 1,000-expression budget on boundary and adversarial wins (#1425)', () => {
  for (const [cols, rows, winLineCount, hasGravity] of BUDGET_BOUNDARY_BOARDS) {
    test(`${cols}x${rows}, ${winLineCount} in a row, gravity ${hasGravity}: forced first and last line wins allow under budget`, () => {
      const config: GameConfig = {
        collection: 'games',
        grid: { cols, rows, cellName: defaultCellName },
        winLineCount,
        hasGravity,
        hasLobby: true,
      };
      const source = assembleGameRules(config);
      const lines = generateWinLines(cols, rows, winLineCount);
      const firstLine = lines[0];
      const lastLine = lines[lines.length - 1];
      expect(firstLine).toBeDefined();
      expect(lastLine).toBeDefined();
      if (firstLine === undefined || lastLine === undefined) return;

      const summary = firestoreRules(source).simulate([
        buildForcedWinCase(config, firstLine, 'host', 0),
        buildForcedWinCase(config, lastLine, 'host'),
        buildForcedWinCase(config, firstLine, 'guest', 0),
        buildForcedWinCase(config, lastLine, 'guest'),
      ]);
      expect(summary.failed).toBe(0);
      expect(summary.unsupported).toBe(0);
      for (const item of summary.cases) {
        expect(item.decision).toBe('ALLOW');
        expect(item.resourceLimit).toBeUndefined();
        expect(item.evaluatedExpressions).toBeLessThan(EXPRESSION_LIMIT);
      }
    }, 30_000);
  }

  test('adversarial near-win saturation on 11x11 (6 in a row) stays well under 1,000 expressions and denies false win claims', () => {
    const grid = { cols: 11, rows: 11, cellName: defaultCellName };
    const winLineCount = 6;
    const config: GameConfig = {
      collection: 'games',
      grid,
      winLineCount,
      hasGravity: false,
      hasLobby: true,
    };
    const source = assembleGameRules(config);
    const ruleset = firestoreRules(source);

    // Center cell (5, 5): populate 2 marks backward and 2 marks forward (total 5 < 6, near-win)
    // along horizontal, vertical, and diag-up so all three earlier directions evaluate deep prefixes
    // before failing, while diag-down (1, -1) completes a real 6-in-a-row win on its last window.
    const beforeCells = emptyBoard(grid);
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1]] as const) {
      for (const step of [-2, -1, 1, 2]) {
        beforeCells[grid.cellName(5 + step * dc, 5 + step * dr)] = 'guest';
      }
    }
    const moveName = grid.cellName(5, 5);
    const nearWinAfter = { ...beforeCells, [moveName]: 'guest' };

    // Without completing diag-down, claiming status == 'won' must DENY without hitting the expression limit.
    const falseClaim = ruleset.simulate([
      {
        description: 'near-win false claim denied cleanly',
        expectation: 'DENY',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u-guest' },
        resource: {
          host: 'u-host',
          guest: 'u-guest',
          currentTurn: 'guest',
          status: 'playing',
          moveCount: 25,
          winner: '',
          lastMove: 'c0r0',
          ...beforeCells,
        },
        data: {
          host: 'u-host',
          guest: 'u-guest',
          currentTurn: 'host',
          status: 'won',
          moveCount: 26,
          winner: 'guest',
          lastMove: moveName,
          ...nearWinAfter,
        },
      },
    ]);
    const denied: CaseResult | undefined = falseClaim.cases[0];
    expect(denied?.decision).toBe('DENY');
    expect(denied?.resourceLimit).toBeUndefined();
    expect(denied?.evaluatedExpressions).toBeLessThan(EXPRESSION_LIMIT);

    // Now complete the 6-cell diag-down line ending at (5, 5): (0,10),(1,9),(2,8),(3,7),(4,6),(5,5).
    const trueWinBefore = { ...beforeCells };
    for (let step = 1; step <= 5; step++) {
      trueWinBefore[grid.cellName(5 - step, 5 + step)] = 'guest';
    }
    const trueWinAfter = { ...trueWinBefore, [moveName]: 'guest' };
    const realWin = ruleset.simulate([
      {
        description: 'adversarial real win on 4th direction last window',
        expectation: 'ALLOW',
        method: 'update',
        path: 'games/g1',
        auth: { uid: 'u-guest' },
        resource: {
          host: 'u-host',
          guest: 'u-guest',
          currentTurn: 'guest',
          status: 'playing',
          moveCount: 35,
          winner: '',
          lastMove: 'c0r0',
          ...trueWinBefore,
        },
        data: {
          host: 'u-host',
          guest: 'u-guest',
          currentTurn: 'host',
          status: 'won',
          moveCount: 36,
          winner: 'guest',
          lastMove: moveName,
          ...trueWinAfter,
        },
      },
    ]);
    const allowed: CaseResult | undefined = realWin.cases[0];
    expect(allowed?.decision).toBe('ALLOW');
    expect(allowed?.resourceLimit).toBeUndefined();
    expect(allowed?.evaluatedExpressions).toBeLessThan(EXPRESSION_LIMIT);
  }, 30_000);
});
