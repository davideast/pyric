/**
 * `build_game_rules` — the generated rules must be REAL rules:
 * parseable + lint-clean (no error-severity findings) for both
 * assembler layouts, with honest metadata, and hard input validation
 * (the 121-cell ceiling exists because the rules complexity ceiling
 * binds above 11x11).
 */
import { describe, expect, test } from 'bun:test';
import { lintFirestoreRules } from 'pyric/rules/internal';
import { buildGameRulesHandler, type BuildGameRulesData } from './buildGameRules';

async function run(args: Parameters<typeof buildGameRulesHandler.execute>[0]) {
  return buildGameRulesHandler.execute(args, undefined as never);
}

function lintErrors(source: string): string[] {
  const result = lintFirestoreRules(source);
  if (result.parseError) return [`parse: ${JSON.stringify(result.parseError)}`];
  return result.warnings.filter((w) => w.severity === 'error').map((w) => `${w.rule}: ${w.message}`);
}

describe('build_game_rules', () => {
  test('tic-tac-toe (classic nested layout) parses + lints clean', async () => {
    const res = await run({ game: 'tic-tac-toe' });
    expect(res.ok).toBe(true);
    const data = res.data as BuildGameRulesData;
    expect(data.optimization).toBe('classic-nested');
    expect(data.cellCount).toBe(9);
    expect(data.rules).toContain("rules_version = '2'");
    expect(data.rules).toContain('match /games/{');
    expect(lintErrors(data.rules)).toEqual([]);
    expect(data.docShape).toContain('board: {');
  });

  test('connect-four (gravity) parses + lints clean with split-allow', async () => {
    const res = await run({ game: 'connect-four', collection: 'matches' });
    expect(res.ok).toBe(true);
    const data = res.data as BuildGameRulesData;
    expect(data.hasGravity).toBe(true);
    expect(data.rules).toContain('match /matches/{');
    // Split-allow: multiple allow update rules (move / wins / draw).
    const allowUpdates = data.rules.match(/allow update:/g) ?? [];
    expect(allowUpdates.length).toBeGreaterThanOrEqual(3);
    expect(lintErrors(data.rules)).toEqual([]);
  });

  test('gomoku 9x9 (81 cells) uses the flat/MapDiff layout and lints clean', async () => {
    const res = await run({ game: 'gomoku' });
    expect(res.ok).toBe(true);
    const data = res.data as BuildGameRulesData;
    expect(data.optimization).toBe('flat-mapdiff');
    expect(data.rules).toContain('affectedKeys');
    expect(data.docShape).toContain('TOP-LEVEL fields');
    expect(lintErrors(data.rules)).toEqual([]);
  });

  test('custom grid works and the 121-cell ceiling is enforced', async () => {
    const ok = await run({ game: 'custom', cols: 5, rows: 5, winLength: 4 });
    expect(ok.ok).toBe(true);
    expect((ok.data as BuildGameRulesData).cellCount).toBe(25);

    const tooBig = await run({ game: 'custom', cols: 12, rows: 12, winLength: 5 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.summary).toContain('exceeds');

    const badWin = await run({ game: 'custom', cols: 3, rows: 3, winLength: 9 });
    expect(badWin.ok).toBe(false);

    const badGrid = await run({ game: 'custom', cols: 0, rows: 3, winLength: 3 });
    expect(badGrid.ok).toBe(false);
  });

  test('rejects a rules-injection collection payload (sec #770)', async () => {
    const malicious = await run({
      game: 'tic-tac-toe',
      collection: 'x/{id} { allow read: if true; } match /pwned',
    });
    expect(malicious.ok).toBe(false);
    expect(malicious.summary).toContain('invalid collection');

    // A plain segment still works and scopes the match block to it.
    const good = await run({ game: 'tic-tac-toe', collection: 'my_games-2' });
    expect(good.ok).toBe(true);
    expect((good.data as BuildGameRulesData).rules).toContain('match /my_games-2/{');
  });
});
