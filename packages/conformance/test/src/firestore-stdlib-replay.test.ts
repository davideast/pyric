/**
 * A stdlib module's production replay covers the module's current
 * cases. `replay-stdlib-cases.ts` writes one observation per module; a case
 * added, removed, renamed or flipped since the replay fails here until the
 * module is replayed again.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYRIC = join(HERE, '..', '..', '..', 'pyric');
const STDLIB = join(PYRIC, 'src', 'rules', 'modules', 'stdlib');
const FIXTURES = join(PYRIC, 'test', 'rules', 'modules', 'fixtures');

interface ReplayObservation {
  schema: string;
  module: string;
  cases: number;
  agree: number;
  results: Array<{ case: string; expectation: string; production: string; state: string }>;
}

const replays = readdirSync(FIXTURES)
  .filter((name) => /^stdlib-replay-[\w-]+\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as ReplayObservation);

describe('stdlib production replays', () => {
  test('the turns and results modules have replays', () => {
    expect(replays.map((r) => r.module)).toEqual(expect.arrayContaining(['results', 'turns']));
  });

  for (const replay of replays) {
    test(`${replay.module}: every current case replayed and agreed with production`, () => {
      expect(replay.schema).toBe('pyric.stdlib-replay.v1');
      const { cases } = JSON.parse(readFileSync(join(STDLIB, `${replay.module}.test.json`), 'utf8')) as {
        cases: Array<{ description: string; expectation: string }>;
      };
      expect(replay.results.map((r) => [r.case, r.expectation])).toEqual(
        cases.map((c) => [c.description, c.expectation]),
      );
      expect(replay.cases).toBe(cases.length);
      expect(replay.agree).toBe(cases.length);
      for (const result of replay.results) {
        expect([result.case, result.state, result.production]).toEqual([result.case, 'SUCCESS', result.expectation]);
      }
    });
  }
});
