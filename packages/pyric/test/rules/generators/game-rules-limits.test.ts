/**
 * Every game the generator accepts must load in production. The documented
 * board range is 1 to 11 rows and columns, with 2 to max(cols, rows) in a
 * row and gravity on or off: 1,650 configs. Each generated ruleset is
 * checked against production's compile limits (`compile-limits.ts`).
 *
 * On main, 34 of the 1,650 failed NESTING_DEPTH; those 34 run on every test
 * run. The full sweep parses every ruleset and takes minutes, so it runs
 * when PYRIC_GAME_RULES_FULL_SWEEP=1 is set.
 *
 * Only those 34 may change. Splitting win lines changes how many
 * expressions a request evaluates, which moves verdicts at production's
 * per-request expression budget, so every ruleset that loaded on main must
 * come out byte-identical to main's.
 */
import { createHash } from 'node:crypto';
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

/**
 * SHA-256 of main's output (66e7a7f53) for configs with more than 64 win
 * lines in one function that loaded on main: 6 of the 118, covering the
 * nested layout (up to 42 cells, Connect Four among them) and the flat one.
 */
const MAIN_OUTPUT_SHA256: ReadonlyArray<readonly [number, number, number, boolean, string]> = [
  [3, 8, 2, false, 'c33799358ac902ebb08cce88ba8da561f0c81e2127c5e72da44da7e6a73941ba'],
  [4, 6, 2, true, '5194c123c5fade280662fc85d304c78ed99d1451773809f13f3d5dfd39723a89'],
  [7, 6, 4, true, '1436f806906985c3e5da36c0d28a62472866527e2a659c18629210e4b511196c'],
  [7, 11, 2, false, 'e3f9f8b06bccb252f3cdc39c544a5da3ac74580f8315f19b847c63de4f248179'],
  [10, 10, 4, true, '764d6c82a771b756c65b3958675f99a61dff149ac17901c118a8dbd6b160960b'],
  [11, 11, 6, false, 'ca693f644318dac5a4cdf6540f8761c01435d3edec18f15f221eb8ff1fd52dfe'],
];

describe('assembleGameRules keeps rulesets that loaded on main byte-identical', () => {
  for (const [cols, rows, winLineCount, hasGravity, sha256] of MAIN_OUTPUT_SHA256) {
    test(`${cols}x${rows}, ${winLineCount} in a row, gravity ${hasGravity}`, () => {
      const source = assembleGameRules({
        collection: 'games',
        grid: { cols, rows, cellName: defaultCellName },
        winLineCount,
        hasGravity,
        hasLobby: true,
      });
      expect(createHash('sha256').update(source).digest('hex')).toBe(sha256);
    }, 30_000);
  }
});

describe('assembleGameRules splits long win line lists only where main failed', () => {
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
