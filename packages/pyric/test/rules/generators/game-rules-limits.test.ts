/**
 * Every game the generator accepts must load in production. The documented
 * board range is 1 to 11 rows and columns, with 2 to max(cols, rows) in a
 * row and gravity on or off: 1,650 configs. Each generated ruleset is
 * checked against production's compile limits (`compile-limits.ts`).
 *
 * Before the win lines split into part functions, 34 of the 1,650 failed
 * NESTING_DEPTH; those 34 run on every test run. The full sweep parses
 * every ruleset and takes minutes, so it runs when
 * PYRIC_GAME_RULES_FULL_SWEEP=1 is set.
 */
import { describe, expect, test } from 'bun:test';
import { assembleGameRules, type GameConfig } from '../../../src/rules/generators/assembler.js';
import { defaultCellName } from '../../../src/rules/generators/grid.js';
import { sourceCompileLimitViolations } from '../../../src/rules/grammar/source-compile-limits.js';

const SIDES = Array.from({ length: 11 }, (_, i) => i + 1);

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

/** The configs whose generated rules production would not compile, with the limit codes. */
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
    const codes = new Set(sourceCompileLimitViolations(source).map((v) => v.code));
    if (codes.size > 0) failing.push(`${describeConfig(config)}: ${[...codes].join(', ')}`);
  }
  return failing;
}

/** [cols, rows, winLineCount] of the configs whose rules failed NESTING_DEPTH on main, each with gravity off and on. */
const FAILED_ON_MAIN: ReadonlyArray<readonly [number, number, number]> = [
  [4, 9, 2], [4, 10, 2], [5, 7, 2], [5, 8, 2], [6, 6, 2], [6, 7, 2], [6, 7, 3],
  [7, 5, 2], [7, 6, 2], [7, 6, 3], [8, 5, 2], [9, 4, 2], [10, 4, 2],
  [10, 11, 2], [11, 10, 2], [11, 11, 2], [11, 11, 3],
];

const runFullSweep = process.env.PYRIC_GAME_RULES_FULL_SWEEP === '1';

describe('assembleGameRules output compiles where it failed on main', () => {
  for (const [cols, rows, winLineCount] of FAILED_ON_MAIN) {
    test(`${cols}x${rows}, ${winLineCount} in a row`, () => {
      const configs = configsFor(cols, rows).filter((config) => config.winLineCount === winLineCount);
      expect(configs).toHaveLength(2);
      expect(failingConfigs(configs)).toEqual([]);
    }, 30_000);
  }
});

describe.skipIf(!runFullSweep)('assembleGameRules output compiles for every documented config', () => {
  test('the sweep covers 1,650 configs', () => {
    const total = SIDES.flatMap((cols) => SIDES.map((rows) => configsFor(cols, rows).length)).reduce((a, b) => a + b, 0);
    expect(total).toBe(1650);
  });

  for (const cols of SIDES) {
    for (const rows of SIDES) {
      test(`${cols}x${rows}`, () => {
        expect(failingConfigs(configsFor(cols, rows))).toEqual([]);
      }, 60_000);
    }
  }
});

describe('assembleGameRules splits long win line lists', () => {
  test('a 6x7 board with 2 in a row ORs part functions in hasWonHost', () => {
    const source = assembleGameRules(configsFor(6, 7)[0]);
    expect(source).toContain('function hasWonHost0(b)');
    expect(source).toContain('function hasWonHost1(b)');
    expect(source).toMatch(/function hasWonHost\(b\) \{\s+return hasWonHost0\(b\) \|\| hasWonHost1\(b\)/);
  });

  test('tic-tac-toe keeps one win function per mark', () => {
    const source = assembleGameRules({ collection: 'games', grid: { cols: 3, rows: 3, cellName: defaultCellName }, winLineCount: 3, hasGravity: false, hasLobby: true });
    expect(source).not.toContain('hasWonHost0');
  });
});
