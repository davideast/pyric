/**
 * Generative verification of Node preload orderings, Worker/child option
 * spellings, TOCTOU option traps, post-boot `NODE_ENV` and `PYRIC_AI_MODE`
 * mutations, and `createRequire` importer-origin spoofing across
 * `@pyric/cli/register` and `@pyric/live/register`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from '../../src/register/child-process-guard.js';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { stopFor } from '../../src/register/swap-or-stop.js';
import type {
  AiModeMutationReport,
  EvalAndTrapReport,
  NodeEnvMutationReport,
  PreloadDriverReport,
  RequireSpoofReport,
} from './register-preload-worker-drivers.js';
import {
  bridgeFiles,
  cliRegisterUrl,
  createRegisterGuardFixture,
  extractJsonLine,
  liveRegisterUrl,
  liveSyncRegisterUrl,
  realSdkEntryUrls,
  runNodeAsync,
  runPair,
  type RegisterGuardFixture,
} from './register-preload-worker-fixture.js';
import {
  generateImporterOriginMatrix,
  generatePostBootAiModeMatrix,
  type ImporterOriginKind,
} from './register-preload-worker-gen.js';

let fx: RegisterGuardFixture | undefined;

function getFixture(): RegisterGuardFixture {
  if (fx === undefined) {
    throw new Error('register guard fixture was not initialized');
  }
  return fx;
}

beforeAll(() => {
  fx = createRegisterGuardFixture();
});

afterAll(() => {
  if (fx !== undefined) {
    rmSync(fx.fixtureDir, { recursive: true, force: true });
  }
});

function callerPreloadIndexExecArgv(rewritten: readonly unknown[], flagKind: string): number {
  if (flagKind === 'import-split') return rewritten.lastIndexOf('--import');
  if (flagKind === 'import-attached') {
    return rewritten.findIndex((t) => typeof t === 'string' && t.startsWith('--import='));
  }
  if (flagKind === 'require-split') return rewritten.lastIndexOf('--require');
  if (flagKind === 'require-attached') {
    return rewritten.findIndex((t) => typeof t === 'string' && t.startsWith('--require='));
  }
  if (flagKind === 'short-r-attached') {
    return rewritten.findIndex((t) => typeof t === 'string' && t.startsWith('-r='));
  }
  return rewritten.indexOf('-r');
}

function callerPreloadIndexNodeOptions(rewritten: string, flagKind: string): number {
  if (flagKind === 'import-split') return rewritten.lastIndexOf('--import ');
  if (flagKind === 'import-attached') return rewritten.indexOf('--import=');
  if (flagKind === 'require-split') return rewritten.lastIndexOf('--require ');
  if (flagKind === 'require-attached') return rewritten.indexOf('--require=');
  if (flagKind === 'short-r-attached') return rewritten.indexOf('-r=');
  return rewritten.indexOf('-r ');
}

describe('Node register, Worker options, and preload ordering cartesian generator', () => {
  it(
    '1. enforces Worker eval truthiness spellings, CJS require/module hoisting, and single-read TOCTOU option snapshots',
    async () => {
      const cur = getFixture();
      const [rSb, rLv] = await runPair(
        () =>
          runNodeAsync(
            ['--import', cliRegisterUrl, cur.driverSandboxEval],
            { PYRIC_SANDBOX: '1' },
            cur.fixtureDir,
          ),
        () => runNodeAsync(['--import', liveRegisterUrl, cur.driverLiveEval], {}, cur.fixtureDir),
      );
      const sb = extractJsonLine<EvalAndTrapReport>(rSb, 'EVAL_REPORT ');
      const lv = extractJsonLine<EvalAndTrapReport>(rLv, 'EVAL_REPORT ');

      const failures: string[] = [];
      for (const [id, outcome] of [
        ...Object.entries(sb.evalCases),
        ...Object.entries(lv.evalCases),
      ]) {
        if (!outcome.guarded) {
          failures.push(`evalCase ${id}: guarded=false (${outcome.detail ?? 'unswapped'})`);
        }
      }
      for (const [surface, traps] of [
        ['sandbox', sb.traps],
        ['live', lv.traps],
      ] as const) {
        for (const [trapId, outcome] of Object.entries(traps)) {
          const expectedMaxReads = trapId === 'elem-getter-execArgv-inject-r' ? 2 : 1;
          if (!outcome.guarded || outcome.reads > expectedMaxReads) {
            failures.push(
              `trap ${surface}/${trapId}: guarded=${String(outcome.guarded)}, reads=${String(outcome.reads)}`,
            );
          }
        }
      }
      expect(failures).toEqual([]);
    },
    90_000,
  );

  it(
    '2. preserves sandbox and live guards across Worker and child env modes after post-boot NODE_ENV=production mutation',
    async () => {
      const cur = getFixture();
      const [rSb, rLv] = await runPair(
        () =>
          runNodeAsync(
            ['--import', cliRegisterUrl, cur.driverSandboxNodeEnv],
            { PYRIC_SANDBOX: '1' },
            cur.fixtureDir,
          ),
        () =>
          runNodeAsync(['--import', liveRegisterUrl, cur.driverLiveNodeEnv], {}, cur.fixtureDir),
      );
      const [rFreshSb, rFreshLv] = await Promise.all([
        runNodeAsync(
          [
            '--import',
            cliRegisterUrl,
            '--input-type=module',
            '-e',
            'console.log("ACTIVE " + Boolean(globalThis[Symbol.for("pyric.register.active")]));',
          ],
          { PYRIC_SANDBOX: '1', NODE_ENV: 'production' },
          cur.fixtureDir,
        ),
        runNodeAsync(
          [
            '--import',
            liveRegisterUrl,
            '--input-type=module',
            '-e',
            'console.log("ACTIVE " + Boolean(globalThis[Symbol.for("pyric.register.live.active")]));',
          ],
          { NODE_ENV: 'production' },
          cur.fixtureDir,
        ),
      ]);
      const sb = extractJsonLine<NodeEnvMutationReport>(rSb, 'NODE_ENV_REPORT ');
      const lv = extractJsonLine<NodeEnvMutationReport>(rLv, 'NODE_ENV_REPORT ');

      const failures: string[] = [];
      for (const [id, outcome] of [
        ...Object.entries(sb.nodeEnvCases),
        ...Object.entries(lv.nodeEnvCases),
      ]) {
        if (!outcome.guarded) {
          failures.push(`${id}: guarded=false (${outcome.detail ?? 'refused'})`);
        }
        if (outcome.leakedForce) {
          failures.push(`${id}: leaked PYRIC_SANDBOX_FORCE into live mode`);
        }
      }
      if (!rFreshSb.stdout.includes('ACTIVE false')) {
        failures.push('fresh sandbox NODE_ENV=production did not refuse');
      }
      if (!rFreshLv.stdout.includes('ACTIVE false')) {
        failures.push('fresh live NODE_ENV=production did not refuse');
      }
      expect(failures).toEqual([]);
    },
    90_000,
  );

  it(
    '3. injects active register ahead of generated --import/--require/-r/-r= orderings and -- end-of-options boundaries',
    async () => {
      const cur = getFixture();
      const failures: string[] = [];
      for (const entry of cur.canonicalPreloadCases) {
        let registerUrl = liveRegisterUrl;
        let syncUrl: string | undefined = liveSyncRegisterUrl;
        if (entry.surface === 'sandbox') {
          registerUrl = cliRegisterUrl;
          syncUrl = undefined;
        }
        const rewrittenArgv = withCanonicalRegisterExecArgv(entry.tokens, registerUrl, syncUrl);
        const callerArgvIdx = callerPreloadIndexExecArgv(rewrittenArgv, entry.flagKind);
        if (rewrittenArgv[0] !== '--require' || callerArgvIdx <= 0) {
          failures.push(`canonicalExecArgv ${entry.id}: ${JSON.stringify(rewrittenArgv)}`);
        }
        const rewrittenOpts = withCanonicalRegisterNodeOptions(
          entry.nodeOptions,
          registerUrl,
          syncUrl,
        );
        const callerOptsIdx = callerPreloadIndexNodeOptions(rewrittenOpts, entry.flagKind);
        if (!rewrittenOpts.startsWith('--require ') || callerOptsIdx <= 0) {
          failures.push(`canonicalNodeOptions ${entry.id}: ${rewrittenOpts}`);
        }
      }

      const [rSb, rLv] = await runPair(
        () =>
          runNodeAsync(
            ['--import', cliRegisterUrl, cur.driverSandboxPreload],
            { PYRIC_SANDBOX: '1' },
            cur.fixtureDir,
          ),
        () =>
          runNodeAsync(['--import', liveRegisterUrl, cur.driverLivePreload], {}, cur.fixtureDir),
      );
      const sb = extractJsonLine<PreloadDriverReport>(rSb, 'PRELOAD_REPORT ');
      const lv = extractJsonLine<PreloadDriverReport>(rLv, 'PRELOAD_REPORT ');

      for (const entry of cur.preloadCases) {
        const report = entry.surface === 'sandbox' ? sb : lv;
        const outcome = report.preloads[entry.id];
        if (!outcome?.guarded || !outcome.earlyGuarded) {
          failures.push(
            `${entry.id}: guarded=${String(outcome?.guarded)}, earlyGuarded=${String(outcome?.earlyGuarded)}`,
          );
        }
      }
      for (const entry of cur.dashCases) {
        const report = entry.surface === 'sandbox' ? sb : lv;
        const outcome = report.dashDash[entry.id];
        const earlyOk = !entry.expectsEarlyHook || outcome?.earlyGuarded === true;
        if (!outcome?.guarded || !earlyOk) {
          failures.push(
            `${entry.id}: guarded=${String(outcome?.guarded)}, earlyGuarded=${String(outcome?.earlyGuarded)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
    120_000,
  );

  it(
    '4. blocks createRequire(importerPath) and decoy-path bridge spoofing while verifying per-specifier stopFor across all 84 combinations',
    async () => {
      const cur = getFixture();
      const [rSpoofSb, rSpoofProd] = await Promise.all([
        runNodeAsync(
          ['--import', cliRegisterUrl, cur.spoofDriver],
          { PYRIC_SANDBOX: '1', PYRIC_AI_MODE: 'sandbox' },
          cur.fixtureDir,
        ),
        runNodeAsync(
          ['--import', cliRegisterUrl, cur.spoofDriver],
          { PYRIC_SANDBOX: '1', PYRIC_AI_MODE: 'production' },
          cur.fixtureDir,
        ),
      ]);
      const requireSpoofSandboxAi = extractJsonLine<RequireSpoofReport>(rSpoofSb, 'SPOOF_REPORT ');
      const requireSpoofProdAi = extractJsonLine<RequireSpoofReport>(rSpoofProd, 'SPOOF_REPORT ');

      const matrix = generateImporterOriginMatrix();
      const failures: string[] = [];
      const importerUrls: Record<ImporterOriginKind, string> = {
        'app-module': pathToFileURL(cur.appModulePath).href,
        'app-decoy-bridge': pathToFileURL(cur.appDecoyBridgePath).href,
        'app-bridge': pathToFileURL(bridgeFiles['app-bridge']).href,
        'app-bridge-shadow': pathToFileURL(bridgeFiles['app-bridge-shadow']).href,
        'app-check-bridge': pathToFileURL(bridgeFiles['app-check-bridge']).href,
        'admin-app-check-bridge': pathToFileURL(bridgeFiles['admin-app-check-bridge']).href,
      };

      for (const entry of matrix) {
        const liveReport =
          entry.aiMode === 'production' ? requireSpoofProdAi : requireSpoofSandboxAi;
        const runtimeOutcome = liveReport.cases[entry.id];
        if (
          runtimeOutcome === undefined ||
          runtimeOutcome.code === 'UNOBSERVED' ||
          runtimeOutcome.loadedReal !== entry.expectedRealUnderRequire
        ) {
          failures.push(
            `createRequire ${entry.id}: loadedReal=${String(runtimeOutcome?.loadedReal)}, code=${String(runtimeOutcome?.code)}`,
          );
        }

        const importer = importerUrls[entry.importerKind];
        const realEntryUrl = realSdkEntryUrls[entry.specifier];

        for (const isEsmImport of [false, true]) {
          let expectedBypass = entry.expectedRealUnderRequire;
          let expectedStopped = entry.expectedStoppedUnderRequire;
          let modeLabel = 'pure-require';
          if (isEsmImport) {
            expectedBypass = entry.expectedRealUnderEsmImport;
            expectedStopped = entry.expectedStoppedUnderEsmImport;
            modeLabel = 'pure-esm';
          }
          const mapped = mapFirebaseSpecifier(entry.specifier, importer, {
            sandbox: '1',
            aiMode: entry.aiMode,
            isEsmImport,
          });
          const stopped = stopFor(
            {
              specifier: entry.specifier,
              importer,
              url: realEntryUrl,
              aiMode: entry.aiMode,
              isEsmImport,
            },
            new Set(),
          );
          const bypassed = mapped === null && stopped === null;
          if (bypassed !== expectedBypass) {
            failures.push(`${modeLabel} ${entry.id}: bypassed=${String(bypassed)}`);
          }
          const didStop = stopped !== null;
          if (didStop !== expectedStopped) {
            failures.push(`${modeLabel}-stopFor ${entry.id}: didStop=${String(didStop)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    },
    60_000,
  );

  it(
    '5. pins PYRIC_AI_MODE and PYRIC_AI_PASSTHROUGH against post-boot mutation across in-process, workers, and children',
    async () => {
      const cur = getFixture();
      const rAi = await runNodeAsync(
        ['--import', cliRegisterUrl, cur.driverSandboxAi],
        { PYRIC_SANDBOX: '1' },
        cur.fixtureDir,
      );
      const aiOutcomes = extractJsonLine<AiModeMutationReport>(rAi, 'AI_REPORT ').aiCases;
      const failures: string[] = [];
      for (const entry of generatePostBootAiModeMatrix()) {
        const outcome = aiOutcomes[entry.id];
        if (outcome === undefined || outcome.loadedRealAi) {
          failures.push(`${entry.id}: loadedRealAi=${String(outcome?.loadedRealAi)}`);
        }
      }
      expect(failures).toEqual([]);
    },
    60_000,
  );
});
