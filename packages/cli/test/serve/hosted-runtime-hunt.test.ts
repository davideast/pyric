import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hosted SQLite persistence deliberately refuses in-process Bun execution
 * (`sqlite.ts`: `Hosted SQLite persistence requires Node >=22.15`).
 * Mirror `hosted-sqlite.test.ts`: bundle scenarios against `@pyric/cli` `dist/`
 * once in `beforeAll` and execute each scenario deterministically under `node`.
 */
import { HOSTED_RUNTIME_HUNT_PART_A } from './fixtures/hosted-runtime-hunt-part-a.js';
import { HOSTED_RUNTIME_HUNT_PART_B } from './fixtures/hosted-runtime-hunt-part-b.js';

const SCENARIO_SOURCE = `${HOSTED_RUNTIME_HUNT_PART_A}\n${HOSTED_RUNTIME_HUNT_PART_B}`;

describe('hosted Node runtime & repro hunt regressions (SW-HST-1..10)', () => {
  let bundleDir = '';
  let scenarioPath = '';

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), 'pyric-hosted-hunt-bundle-'));
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(bundleDir, 'node_modules'), 'dir');
    const distUrl = new URL('../../dist', import.meta.url).href;
    const entry = join(bundleDir, 'entry.ts');
    writeFileSync(entry, SCENARIO_SOURCE.replaceAll('@dist/', `${distUrl}/`));
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: bundleDir,
      target: 'node',
      packages: 'external',
      naming: 'scenario.mjs',
    });
    expect(build.success).toBe(true);
    scenarioPath = join(bundleDir, 'scenario.mjs');
  }, 60_000);

  afterAll(() => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  });

  function runScenario(id: string): void {
    const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [scenarioPath, id], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`Scenario ${id} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
  }

  test('SW-HST-1: sandbox.reset preserves active rules, RTDB rules, live subscriptions, and reconciles cleared sessions', () => {
    runScenario('sw-hst-1');
  }, 45_000);

  test('SW-HST-3: resumeSession revives disconnected sessions while keeping non-resumed disconnects closed, and routes replies per message transport', () => {
    runScenario('sw-hst-3');
  }, 45_000);

  test('SW-HST-4: deployRules rejects invalid Firestore/RTDB rules without poisoning repro entries, and rules.set updates activeRules', () => {
    runScenario('sw-hst-4');
  }, 45_000);

  test('SW-HST-5: storage byte route rejects out-of-bounds, backwards, and mismatched-length Content-Range requests with 400', () => {
    runScenario('sw-hst-5');
  }, 45_000);

  test('SW-HST-7b: captureReproBase preserves RTDB priorities on non-default instances across window rollovers', () => {
    runScenario('sw-hst-7b');
  }, 45_000);

  test('SW-HST-8: repro records worker-client-disconnect / worker-client-interrupted and Storage HTTP byte-route uploads across both planes', () => {
    runScenario('sw-hst-8');
  }, 45_000);

  test('SW-HST-9: custom-token signInProvider and customClaims survive repro window rollover on replay', () => {
    runScenario('sw-hst-9');
  }, 45_000);

  test('SW-HST-10: runMethod, captureRepro, and mcpProjectError accept symlinked project directories while rejecting outside directories', () => {
    runScenario('sw-hst-10');
  }, 45_000);

  test('SW-HST-11: caller defaultBucket aliases persist across Node host restarts so download URLs resolve on cold boot', () => {
    runScenario('sw-hst-11');
  }, 45_000);

  test('SW-HST-12: firestore_simulator_create refuses rules production would not load, and the host never reports a refused source active (FS2-ENF-3a, FS2-ENF-3b)', () => {
    runScenario('sw-hst-12');
  }, 45_000);
});
