/**
 * Fixture-ladder sanity suite (workstation-benchmarks.md §3a).
 *
 * Structural gate over every app-build fixture: parses, unique ids, valid
 * tiers, well-formed held-out cases. For T4 retrofit fixtures it also
 * asserts the fixture STARTS GREEN: the initialWorkspace's own
 * `/workspace/tests/*.test.json` must pass against the initialWorkspace's
 * own rules through the real workspace-tests runner — a retrofit fixture
 * whose seeded app is already broken would grade "did the agent break it"
 * against a lie.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseWorkspaceTestFile, runWorkspaceTests } from '~/lib/workspace-tests/runner';

const FIXTURES_DIR = import.meta.dir;
const METHODS = ['get', 'list', 'create', 'update', 'delete'] as const;

interface FixtureCase {
  method: string;
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  expect: string;
}
interface Fixture {
  id: string;
  tier?: number;
  domain: string;
  auth: string;
  security: string;
  prompt: string;
  cases: FixtureCase[];
  initialWorkspace?: Record<string, string>;
}

const files = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const fixtures: Array<{ file: string; fixture: Fixture }> = files.map((file) => ({
  file,
  fixture: JSON.parse(readFileSync(resolve(FIXTURES_DIR, file), 'utf8')) as Fixture,
}));

describe('app-build fixture ladder', () => {
  test('at least the six epic fixtures plus the T2–T4 ladder exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  test('every fixture id is unique and matches its filename', () => {
    const ids = fixtures.map((f) => f.fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { file, fixture } of fixtures) {
      expect(file).toBe(`${fixture.id}.json`);
    }
  });

  test('the ladder has a fixture at every tier 2–4', () => {
    const tiers = new Set(fixtures.map((f) => f.fixture.tier ?? 1));
    expect(tiers.has(2)).toBe(true);
    expect(tiers.has(3)).toBe(true);
    expect(tiers.has(4)).toBe(true);
  });

  for (const { file, fixture } of fixtures) {
    describe(file, () => {
      test('required fields + valid tier', () => {
        expect(typeof fixture.id).toBe('string');
        expect(fixture.id.length).toBeGreaterThan(0);
        expect(typeof fixture.prompt).toBe('string');
        expect(fixture.prompt.length).toBeGreaterThan(0);
        expect(typeof fixture.domain).toBe('string');
        expect(typeof fixture.auth).toBe('string');
        expect(typeof fixture.security).toBe('string');
        if (fixture.tier !== undefined) {
          expect(Number.isInteger(fixture.tier)).toBe(true);
          expect(fixture.tier).toBeGreaterThanOrEqual(1);
          expect(fixture.tier).toBeLessThanOrEqual(4);
        }
      });

      test('every held-out case is well-formed', () => {
        expect(Array.isArray(fixture.cases)).toBe(true);
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const c of fixture.cases) {
          expect(METHODS).toContain(c.method as (typeof METHODS)[number]);
          expect(typeof c.path).toBe('string');
          // Held-out cases use doc-style paths (even for `list` — the
          // simulator's collection-path list matching is a known parity
          // defect): segments must be even, no leading/trailing slash.
          expect(c.path.startsWith('/')).toBe(false);
          expect(c.path.endsWith('/')).toBe(false);
          expect(c.path.split('/').length % 2).toBe(0);
          expect(['ALLOW', 'DENY']).toContain(c.expect);
          if (c.auth !== null) {
            expect(typeof c.auth.uid).toBe('string');
            expect(c.auth.uid.length).toBeGreaterThan(0);
            if (c.auth.token !== undefined) expect(typeof c.auth.token).toBe('object');
          }
          // `data` is optional even on create/update (several T1 fixtures
          // assert pure identity rules with no field validation) — but when
          // present, both must be objects.
          if (c.data !== undefined) expect(typeof c.data).toBe('object');
          if (c.resource !== undefined) expect(typeof c.resource).toBe('object');
        }
      });

      if (fixture.initialWorkspace) {
        describe('initialWorkspace (T4 retrofit)', () => {
          const iw = fixture.initialWorkspace!;
          const priorTests = Object.entries(iw)
            .filter(([p]) => p.startsWith('/workspace/tests/') && p.endsWith('.test.json'))
            .map(([name, content]) => ({ name, content }));

          test('declares workspace-rooted paths, rules, an App entry, and at least one test file', () => {
            for (const p of Object.keys(iw)) expect(p.startsWith('/workspace/')).toBe(true);
            expect(typeof iw['/workspace/firestore.rules']).toBe('string');
            expect(typeof iw['/workspace/src/App.tsx']).toBe('string');
            expect(priorTests.length).toBeGreaterThan(0);
          });

          test('every seeded test file parses as a workspace test file', () => {
            for (const t of priorTests) {
              expect(() => parseWorkspaceTestFile(t.content)).not.toThrow();
            }
          });

          test('the fixture starts green: seeded tests pass against seeded rules', async () => {
            const report = await runWorkspaceTests(priorTests, iw['/workspace/firestore.rules']!);
            expect(report.files.map((f) => f.error).filter(Boolean)).toEqual([]);
            expect(report.files.flatMap((f) => f.failures)).toEqual([]);
            expect(report.ok).toBe(true);
            expect(report.passed).toBe(report.total);
          });
        });
      }
    });
  }
});
