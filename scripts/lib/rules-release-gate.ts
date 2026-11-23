#!/usr/bin/env bun
/**
 * Release gates for `@pyric/rules` (`scripts/publish-alpha.sh --package rules`).
 *
 *   bun scripts/lib/rules-release-gate.ts proof
 *   bun scripts/lib/rules-release-gate.ts tarball <path-to-pyric-rules-tgz>
 *
 * `proof` builds the workspace packages and executes every command in
 * `RULES_ONLY_PROOF` (from `scripts/ci/check-set.ts`) so the release gate
 * cannot drift from the rules proof definition.
 *
 * `tarball` checks the exact `.tgz` bytes `pack-packages.sh --package rules`
 * produced: static manifest and declaration checks (`publint`, `attw`,
 * `check-exports`, `check-declaration-deps`), fresh `npm install` into an
 * empty directory, Node evaluation of Firestore/Storage/RTDB rules from the
 * installed package, and browser bundling (`target: 'browser'`) verifying zero
 * `node:` or Node built-in imports outside `@pyric/rules/internal/node`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';
import { RULES_ONLY_PROOF } from '../ci/check-set.ts';
import { undeclaredDeclarationImports } from './check-declaration-deps.mjs';
import { takeHeavyRunSlot } from './heavy-run-slots.ts';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from './private-job-tmpdir.ts';
import { addCounts, emptyCounts, formatCounts } from './test-all/counts.ts';
import { planJobs, type TestJob } from './test-all/plan.ts';
import { runJobs, type JobResult } from './test-all/run-jobs.ts';
import { spawnJob, stopRunningJobs } from './test-all/spawn-job.ts';
import { summaryProblem } from './test-all/summary-check.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_NAME = '@pyric/rules';
const EXPECTED_INSTALLED = ['@pyric/rules', 'ohm-js', 'zod'];
const FORBIDDEN_INSTALLED = ['pyric', 'firebase', 'firebase-admin', 'typescript'];
const BUILTIN_NAMES = new Set(builtinModules.map((mod) => mod.split('/')[0] ?? mod));
const LITERAL_IMPORT_RE = /\b(?:from\s*['"`]([^'"`]+)['"`]|import\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

interface LockEntry {
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

function gateError(message: string): Error {
  return new Error(`rules-release-gate: ${message}`);
}

function describeGateError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runInherited(command: string, args: string[], cwd = REPO_ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw gateError(`${command} ${args.join(' ')} exited with code ${String(result.status ?? 1)}`);
  }
}

function runCaptured(command: string, args: string[], cwd: string): { status: number; output: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('@')) return false;
  const rootName = specifier.split('/')[0] ?? specifier;
  return BUILTIN_NAMES.has(rootName);
}

function withSummaryCheck(result: JobResult): JobResult {
  const problem = summaryProblem(result.job, result.counts);
  if (problem === undefined) return result;
  let exitCode = result.exitCode;
  if (exitCode === 0) exitCode = 1;
  return {
    ...result,
    exitCode,
    failedTests: [...result.failedTests, `[rules-proof] ${problem}`],
  };
}

function logPathFor(logDir: string, job: TestJob): string {
  return join(logDir, `${job.name.replace(/[^\w.-]+/g, '-')}.log`);
}

const CONFORMANCE_SUITE_STEP = 'bun test --cwd packages/conformance';
const RULES_SHARD_COUNT = 6;

/**
 * Long property/fuzz files in `packages/rules` whose explicit per-test budgets
 * (20s-120s) sit close to single-core wall time on 2.20GHz virtualized Linux
 * vCPUs when retained JSC heap from earlier shard files adds GC sweep time.
 * Running each in its own single-file `bun test` process keeps every file,
 * test, and timeout unchanged while starting each heavy suite with a clean heap.
 */
export const ISOLATED_RULES_FILES = [
  './test/generators/game-rules-limits.test.ts',
  './test/grammar/source-segments.test.ts',
  './test/rtdb/adversarial-challenger.test.ts',
  './test/rtdb/grammar/canonical.test.ts',
  './test/rtdb/grammar/linter.test.ts',
  './test/rtdb/grammar/regex-dialect.test.ts',
  './test/rtdb/rules-diff.test.ts',
] as const;

const ISOLATED_RULES_SET = new Set<string>(ISOLATED_RULES_FILES);

function isBuildOrTypecheckStep(command: string): boolean {
  return command.endsWith(' typecheck') || command.endsWith(' build');
}

export function planRulesProofJobs(repoRoot = REPO_ROOT): TestJob[] {
  const nonConformanceTestSteps = RULES_ONLY_PROOF.filter(
    (cmd) => !isBuildOrTypecheckStep(cmd) && cmd !== CONFORMANCE_SUITE_STEP,
  );
  const rawJobs = planJobs(nonConformanceTestSteps.join(' && '), {
    root: repoRoot,
    shards: RULES_SHARD_COUNT,
  });
  const isolated: TestJob[] = [];
  const sharded: TestJob[] = [];
  for (const job of rawJobs) {
    if (!job.runsBunTest || !job.name.startsWith('rules ')) {
      sharded.push(job);
      continue;
    }
    const kept: string[] = [];
    for (const arg of job.args.slice(1)) {
      if (ISOLATED_RULES_SET.has(arg)) {
        isolated.push({
          name: `rules ${arg.replace(/^\.\/test\//, '')}`,
          command: job.command,
          args: ['test', arg],
          cwd: job.cwd,
          runsBunTest: true,
          expectedFiles: 1,
        });
      } else {
        kept.push(arg);
      }
    }
    if (kept.length > 0) {
      sharded.push({
        ...job,
        args: ['test', ...kept],
        expectedFiles: kept.length,
      });
    }
  }
  isolated.sort((a, b) => (a.args[1] ?? '').localeCompare(b.args[1] ?? ''));
  return [...isolated, ...sharded];
}

async function runJobBatch(
  label: string,
  jobs: TestJob[],
  concurrency: number,
  logDir: string,
): Promise<JobResult[]> {
  console.log(`=== rules release gate: ${label} (${jobs.length} job(s), ${concurrency} at a time) ===`);
  const rawResults = await runJobs(
    jobs,
    concurrency,
    (job) => spawnJob(job, { logPath: logPathFor(logDir, job), echo: false }),
    (raw) => {
      const checked = withSummaryCheck(raw);
      let statusLabel = 'ok';
      if (checked.exitCode !== 0) statusLabel = 'FAIL';
      console.log(
        `  ${statusLabel} ${checked.job.name} (${checked.seconds.toFixed(1)}s): ${checked.counts.pass} pass, ${checked.counts.fail} fail`,
      );
    },
  );
  const results = rawResults.map(withSummaryCheck);
  for (const failure of results.filter((r) => r.exitCode !== 0)) {
    console.error(`\n=== FAIL ${failure.job.name}: exit ${failure.exitCode}, log ${logPathFor(logDir, failure.job)} ===`);
    console.error([...failure.failedTests, '...', ...failure.tail].join('\n'));
  }
  return results;
}

async function runRulesProof(): Promise<void> {
  await takeHeavyRunSlot();
  console.log('=== rules release gate: build workspace packages ===');
  runInherited('bash', ['scripts/build.sh', '--packages-only']);

  const setupSteps = RULES_ONLY_PROOF.filter(isBuildOrTypecheckStep);
  const hasConformanceStep = RULES_ONLY_PROOF.includes(CONFORMANCE_SUITE_STEP);
  for (const command of setupSteps) {
    console.log(`=== rules release gate: ${command} ===`);
    runInherited('/bin/bash', ['-euo', 'pipefail', '-c', command]);
  }

  // Run isolated heavy property files and the 6 rules shards 1 at a time across
  // separate Bun processes so JSC heap does not accumulate across suites.
  const rulesJobs = planRulesProofJobs(REPO_ROOT);
  const logDir = join(REPO_ROOT, 'test-results/rules-release-proof');
  mkdirSync(logDir, { recursive: true });

  const onSignal = (code: number) => () => {
    stopRunningJobs('SIGTERM');
    process.exit(code);
  };
  process.on('SIGHUP', onSignal(129));
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  const startedAt = performance.now();
  const allResults: JobResult[] = [];
  allResults.push(...(await runJobBatch('rules shards and readers', rulesJobs, 1, logDir)));
  if (hasConformanceStep && allResults.every((r) => r.exitCode === 0)) {
    const conformanceJobs = planJobs(CONFORMANCE_SUITE_STEP, { root: REPO_ROOT, shards: 1 });
    allResults.push(...(await runJobBatch('conformance suite (isolated)', conformanceJobs, 1, logDir)));
  }

  const failed = allResults.filter((r) => r.exitCode !== 0);
  const total = allResults.map((r) => r.counts).reduce(addCounts, emptyCounts());
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `rules-release-gate: ${formatCounts(total)}; ${allResults.length - failed.length}/${allResults.length} jobs passed in ${elapsed}s`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

const NODE_CONSUMER_SMOKE = `
import assert from 'node:assert/strict';
import { assertCase, explainCase, firestoreRules, lint, rtdbRules, storageRules } from '@pyric/rules';
import * as internal from '@pyric/rules/internal';
import * as internalNode from '@pyric/rules/internal/node';
import * as internalRtdb from '@pyric/rules/internal/rtdb';
import * as internalStorage from '@pyric/rules/internal/storage';

assert.equal(typeof internal.parseToAST, 'function');
assert.equal(typeof internalNode.resolveModules, 'function');
assert.equal(typeof internalRtdb.compileRtdbRules, 'function');
assert.equal(typeof internalStorage.evaluateStorageRules, 'function');

const fsSource = \`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.owner;
    }
  }
}\`;
const fsRules = firestoreRules(fsSource);
assert.equal(Array.isArray(lint(fsSource)), true);
assert.equal(fsRules.lint().filter((issue) => issue.severity === 'error').length, 0);
assertCase(fsRules, {
  description: 'owner reads note',
  expectation: 'ALLOW',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  resource: { owner: 'alice' },
});
const strangerCase = {
  description: 'stranger denied',
  expectation: 'DENY',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'bob' },
  resource: { owner: 'alice' },
};
assert.equal(fsRules.explain(strangerCase).decision, 'DENY');
const simulated = fsRules.simulate([strangerCase]);
assert.equal(typeof explainCase(simulated.cases[0]), 'string');

const stRules = storageRules(\`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid} {
      allow get: if request.auth != null && request.auth.uid == uid;
    }
  }
}\`, { bucket: 'demo.appspot.com' });
assertCase(stRules, {
  description: 'owner reads avatar',
  expectation: 'ALLOW',
  method: 'get',
  path: 'avatars/alice',
  auth: { uid: 'alice' },
  resource: { size: 16, contentType: 'image/png' },
});

const dbRules = rtdbRules(JSON.stringify({
  rules: {
    items: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
      },
    },
  },
}));
assertCase(dbRules, {
  description: 'owner reads item',
  expectation: 'ALLOW',
  operation: 'read',
  path: '/items/alice',
  auth: { uid: 'alice' },
});
console.log('node-consumer-ok');
`;

function subpathSpecifier(subpath: string): string {
  if (subpath === '.') return PACKAGE_NAME;
  return `${PACKAGE_NAME}/${subpath.slice(2)}`;
}

export async function verifyBrowserBundlesHaveNoNodeBuiltins(
  workDir: string,
  installedPackageDir: string,
): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(join(installedPackageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | { import?: string }>;
  };
  const exportsMap = manifest.exports ?? {};
  const browserSubpaths = Object.keys(exportsMap).filter(
    (subpath) => subpath !== './internal/node' && !subpath.endsWith('.json'),
  );
  if (browserSubpaths.length === 0) {
    return ['no browser-eligible exports found on @pyric/rules'];
  }

  const violations: string[] = [];
  for (const subpath of browserSubpaths) {
    const specifier = subpathSpecifier(subpath);
    const entryPath = join(workDir, `browser-entry-${subpath.replace(/[^a-z0-9]+/gi, '_')}.mjs`);
    writeFileSync(entryPath, `export * from '${specifier}';\n`);

    const resolvedFiles = new Set<string>();
    const buildResult = await Bun.build({
      entrypoints: [entryPath],
      target: 'browser',
      format: 'esm',
      plugins: [
        {
          name: 'forbid-node-builtins-outside-internal-node',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (isNodeBuiltinSpecifier(args.path)) {
                violations.push(`${specifier}: imports Node built-in '${args.path}' from ${args.importer}`);
              }
              return undefined;
            });
            build.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
              resolvedFiles.add(args.path);
              return undefined;
            });
          },
        },
      ],
    });

    if (!buildResult.success) {
      const messages = buildResult.logs.map((log) => log.message).join('; ');
      violations.push(`${specifier}: browser bundle failed (${messages || 'unknown build error'})`);
    }

    for (const file of resolvedFiles) {
      if (!existsSync(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(LITERAL_IMPORT_RE)) {
        const target = match[1] ?? match[2] ?? '';
        if (target !== '' && isNodeBuiltinSpecifier(target)) {
          violations.push(`${specifier}: literal built-in import '${target}' in ${relative(workDir, file)}`);
        }
      }
    }
  }
  return violations;
}

export async function checkRulesTarball(tarballArg: string): Promise<void> {
  const tarball = resolve(tarballArg);
  if (!existsSync(tarball)) {
    throw gateError(`tarball does not exist: ${tarball}`);
  }
  const tarballIntegrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;

  const workDir = createPrivateJobTmpDir('rules-tgz');
  try {
    console.log(`=== rules tarball gate: static checks on ${basename(tarball)} ===`);
    const publint = runCaptured(join(REPO_ROOT, 'node_modules/.bin/publint'), ['run', tarball], REPO_ROOT);
    if (publint.status !== 0) {
      throw gateError(`publint failed on ${basename(tarball)}:\n${publint.output}`);
    }
    const attw = runCaptured(
      join(REPO_ROOT, 'node_modules/.bin/attw'),
      [tarball, '--profile', 'esm-only'],
      REPO_ROOT,
    );
    if (attw.status !== 0) {
      throw gateError(`attw failed on ${basename(tarball)}:\n${attw.output}`);
    }

    console.log(`=== rules tarball gate: empty-directory install (${basename(tarball)}) ===`);
    writeFileSync(
      join(workDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'rules-tarball-gate-consumer',
          private: true,
          type: 'module',
          dependencies: {
            [PACKAGE_NAME]: `file:${tarball}`,
          },
        },
        null,
        2,
      )}\n`,
    );

    const install = runCaptured(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error', '--progress=false', '--update-notifier=false'],
      workDir,
    );
    if (install.status !== 0) {
      throw gateError(`npm install failed (exit ${install.status}):\n${install.output}`);
    }

    const installedPkgDir = join(workDir, 'node_modules', PACKAGE_NAME);
    if (!existsSync(installedPkgDir) || lstatSync(installedPkgDir).isSymbolicLink()) {
      throw gateError(`node_modules/${PACKAGE_NAME} must be an installed directory, not a symlink`);
    }

    const exportsCheck = runCaptured(
      'node',
      [join(REPO_ROOT, 'scripts/lib/check-exports.mjs'), installedPkgDir],
      workDir,
    );
    if (exportsCheck.status !== 0) {
      throw gateError(`exports <-> dist check failed on installed tarball:\n${exportsCheck.output}`);
    }

    const lockfile = JSON.parse(readFileSync(join(workDir, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, LockEntry>;
    };
    const lockPackages = lockfile.packages ?? {};
    const rulesEntry = lockPackages[`node_modules/${PACKAGE_NAME}`];
    if (!rulesEntry || rulesEntry.link === true) {
      throw gateError(`${PACKAGE_NAME} was linked instead of installed from tarball`);
    }
    if (basename(rulesEntry.resolved ?? '') !== basename(tarball) || rulesEntry.integrity !== tarballIntegrity) {
      throw gateError(`${PACKAGE_NAME} lockfile entry does not match ${basename(tarball)} integrity`);
    }

    const installedNames = [
      ...new Set(
        Object.keys(lockPackages)
          .filter((key) => key !== '')
          .map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)),
      ),
    ].sort();
    if (JSON.stringify(installedNames) !== JSON.stringify(EXPECTED_INSTALLED)) {
      throw gateError(`expected installed set ${EXPECTED_INSTALLED.join(', ')}, got ${installedNames.join(', ')}`);
    }
    for (const forbidden of FORBIDDEN_INSTALLED) {
      if (existsSync(join(workDir, 'node_modules', forbidden))) {
        throw gateError(`unexpected dependency installed alongside ${PACKAGE_NAME}: ${forbidden}`);
      }
    }

    const undeclared = undeclaredDeclarationImports(installedPkgDir);
    if (undeclared.length > 0) {
      throw gateError(`undeclared .d.ts imports in packed ${PACKAGE_NAME}: ${undeclared.join(', ')}`);
    }

    console.log('=== rules tarball gate: Node runtime import and evaluation ===');
    const nodeSmoke = runCaptured('node', ['--input-type=module', '-e', NODE_CONSUMER_SMOKE], workDir);
    if (nodeSmoke.status !== 0 || !nodeSmoke.output.includes('node-consumer-ok')) {
      throw gateError(`Node import smoke failed (exit ${nodeSmoke.status}):\n${nodeSmoke.output}`);
    }

    console.log('=== rules tarball gate: browser bundle check (zero node: outside /internal/node) ===');
    const violations = await verifyBrowserBundlesHaveNoNodeBuiltins(workDir, installedPkgDir);
    if (violations.length > 0) {
      throw gateError(`browser bundle check failed:\n  - ${violations.join('\n  - ')}`);
    }
    console.log(`ok ${basename(tarball)} passed fresh install, Node import, and browser bundle checks`);
  } finally {
    removePrivateJobTmpDir(workDir);
  }
}

if (import.meta.main) {
  const [subcommand, ...rest] = process.argv.slice(2);
  try {
    if (subcommand === 'proof' && rest.length === 0) {
      await runRulesProof();
    } else if (subcommand === 'tarball' && rest.length === 1 && rest[0]) {
      await checkRulesTarball(rest[0]);
    } else {
      console.error('usage: bun scripts/lib/rules-release-gate.ts proof | tarball <path-to-tgz>');
      process.exit(2);
    }
  } catch (error) {
    console.error(describeGateError(error));
    process.exit(1);
  }
}
