#!/usr/bin/env bun
/**
 * Main-only production oracle capture runner and isolated PR opener for
 * `.github/workflows/oracle-capture.yml`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { loadRigManifests } from '../../packages/conformance/rigs/load.ts';
import type { Gh } from './github-issues.ts';
import { spawnGh } from './github-issues.ts';
import {
  assertStagedPathsAreObservationsOnly,
  createOrUpdatePullRequestWithFallback,
  formatPullRequestOutcomesSummary,
  preserveIdenticalProtectedObservations,
  resolveCaptureBundleDirs,
  resolveCaptureTargetBranch,
  spawnGhWithToken,
  type OpenedPullRequestOutcome,
  type PullRequestAuth,
} from './oracle-capture-open-pr.ts';
import { runReconcileDivertedCli } from './oracle-capture-reconcile-diverted.ts';
import {
  appendGithubOutput,
  appendStepSummary,
  assertMainBranchContext,
  diagnoseCaptureFailure,
  planCaptureRun,
  type CapturePlan,
  type PlannedRigInvocation,
} from './oracle-capture-plan.ts';
import {
  assertCleanWorkingTreeForCapture,
  assertValidObservationEnvelope,
  canonicalizeObservation,
  collectTimestampCleanObservations,
  validateObservationRelativePath,
  type CollectedObservationChange,
} from './oracle-observation-diff.ts';

const SAFE_RIG_ID = /^[a-z0-9-]+$/;

export interface CaptureBundleRigEntry {
  rig: string;
  filter?: string;
  files: CollectedObservationChange[];
}

export interface CaptureBundleManifest {
  sourceSha: string;
  runUrl?: string;
  rigs: CaptureBundleRigEntry[];
}

function resetObservationsTree(cwd: string): void {
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', 'packages/conformance/observations'],
    { cwd, encoding: 'utf8' },
  ).trim();
  if (tracked !== '') {
    execFileSync('git', ['checkout', '--', 'packages/conformance/observations'], { cwd });
  }
  execFileSync('git', ['clean', '-fd', '--', 'packages/conformance/observations'], { cwd });
}

function groupInvocationsByRig(
  invocations: readonly PlannedRigInvocation[],
): Map<string, PlannedRigInvocation[]> {
  const grouped = new Map<string, PlannedRigInvocation[]>();
  for (const inv of invocations) {
    const list = grouped.get(inv.rig) ?? [];
    list.push(inv);
    grouped.set(inv.rig, list);
  }
  return grouped;
}

export function buildInvocationEnv(
  baseEnv: NodeJS.ProcessEnv,
  inv: PlannedRigInvocation,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  delete nextEnv.GOOGLE_APPLICATION_CREDENTIALS;

  if (inv.wifTier === 'parity-readonly') {
    const parityCredFile = (baseEnv.PARITY_WIF_CREDENTIALS_FILE ?? '').trim();
    if (!parityCredFile) {
      throw new Error(
        `Missing PARITY_WIF_CREDENTIALS_FILE for parity-readonly rig '${inv.rig}'`,
      );
    }
    nextEnv.GOOGLE_APPLICATION_CREDENTIALS = parityCredFile;
  } else if (inv.wifTier === 'capture-write') {
    const captureCredFile = (baseEnv.CAPTURE_WIF_CREDENTIALS_FILE ?? '').trim();
    if (!captureCredFile) {
      throw new Error(
        `Missing CAPTURE_WIF_CREDENTIALS_FILE for capture-write rig '${inv.rig}'`,
      );
    }
    nextEnv.GOOGLE_APPLICATION_CREDENTIALS = captureCredFile;
  }
  return nextEnv;
}

export interface InvocationRunOutcome {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export function executeCapturePlan(options: {
  cwd: string;
  artifactDir: string;
  env: NodeJS.ProcessEnv;
  plan: CapturePlan;
  runInvocation?: (inv: PlannedRigInvocation) => InvocationRunOutcome;
}): { hasCaptures: boolean; hadRigFailure: boolean } {
  const { cwd, artifactDir, env, plan } = options;
  const runInvocation =
    options.runInvocation ??
    ((inv: PlannedRigInvocation): InvocationRunOutcome => {
      console.log(
        `[oracle-capture] running ${inv.rig}: bun run ${inv.script} ${inv.args.join(' ')}`.trim(),
      );
      const out = spawnSync('bun', ['run', inv.script, ...inv.args], {
        cwd,
        env: buildInvocationEnv(env, inv),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
      return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    });

  assertCleanWorkingTreeForCapture(cwd);

  if (!plan.shouldRun || plan.invocations.length === 0) {
    appendGithubOutput(env, 'has_captures', 'false');
    return { hasCaptures: false, hadRigFailure: false };
  }

  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(artifactDir, { recursive: true });

  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  let runUrl: string | undefined;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }

  const grouped = groupInvocationsByRig(plan.invocations);
  const bundleRigs: CaptureBundleRigEntry[] = [];
  let hadRigFailure = false;

  for (const [rig, rigInvocations] of grouped.entries()) {
    const rigBundleDir = join(artifactDir, 'rigs', rig);
    const collectedByPath = new Map<string, CollectedObservationChange>();
    const succeededFilters: string[] = [];

    for (const inv of rigInvocations) {
      const out = runInvocation(inv);
      const invFailed = out.status !== 0;
      if (invFailed) {
        const combined = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
        const report = diagnoseCaptureFailure(rig, combined, env);
        appendStepSummary(env, report);
        console.error(report);
        hadRigFailure = true;
      }

      const scratchDiscardDir = mkdtempSync(join(tmpdir(), 'oracle-capture-discard-'));
      try {
        const targetOutDir = invFailed ? scratchDiscardDir : rigBundleDir;
        const collected = collectTimestampCleanObservations(cwd, targetOutDir);
        if (!invFailed && collected.length > 0) {
          for (const item of collected) {
            collectedByPath.set(item.path, item);
          }
          const filterArg = inv.args
            .filter((a) => a !== '--write' && a !== '--capture' && !a.startsWith('--'))
            .join(',');
          if (filterArg) succeededFilters.push(filterArg);
        }
      } catch (boundaryErr) {
        rmSync(artifactDir, { recursive: true, force: true });
        appendGithubOutput(env, 'has_captures', 'false');
        throw boundaryErr;
      } finally {
        rmSync(scratchDiscardDir, { recursive: true, force: true });
        resetObservationsTree(cwd);
      }
    }

    if (collectedByPath.size > 0) {
      const files = [...collectedByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
      const entry: CaptureBundleRigEntry = { rig, files };
      const filterSummary = succeededFilters.join(', ');
      if (filterSummary) entry.filter = filterSummary;
      bundleRigs.push(entry);
    } else {
      rmSync(rigBundleDir, { recursive: true, force: true });
    }
  }

  if (bundleRigs.length === 0) {
    rmSync(artifactDir, { recursive: true, force: true });
    appendGithubOutput(env, 'has_captures', 'false');
    if (!hadRigFailure) {
      const cleanMsg = '## Oracle capture: no non-timestamp observation changes produced.';
      appendStepSummary(env, cleanMsg);
      console.log(cleanMsg);
    }
    return { hasCaptures: false, hadRigFailure };
  }

  const manifest: CaptureBundleManifest = { sourceSha, rigs: bundleRigs };
  if (runUrl) manifest.runUrl = runUrl;
  writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendGithubOutput(env, 'has_captures', 'true');

  const summaryLines = [
    '## Oracle capture bundle prepared',
    '',
    ...bundleRigs.flatMap((entry) => [
      `- **${entry.rig}** (${entry.files.length} file(s)):`,
      ...entry.files.map((f) => `  - \`${f.path}\` (${f.kind})`),
    ]),
  ];
  appendStepSummary(env, summaryLines.join('\n'));
  return { hasCaptures: true, hadRigFailure };
}

async function runCaptureCommand(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assertMainBranchContext(env);
  const planFile = env.PLAN_FILE;
  const artifactDir = env.ARTIFACT_DIR;
  if (!planFile || !artifactDir) {
    throw new Error('PLAN_FILE and ARTIFACT_DIR environment variables are required');
  }
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as CapturePlan;
  const { hadRigFailure } = executeCapturePlan({ cwd, artifactDir, env, plan });
  if (hadRigFailure) process.exit(1);
}

function assertNoSymlinksAndCollectRegularFiles(rootDir: string): string[] {
  const rootStat = lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Artifact directory '${rootDir}' is missing or a symlink`);
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlink in downloaded artifact bundle: ${relative(rootDir, full)}`);
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        files.push(relative(rootDir, full).replace(/\\/g, '/'));
      } else {
        throw new Error(`Refusing non-regular file in artifact bundle: ${relative(rootDir, full)}`);
      }
    }
  };
  walk(rootDir);
  return files;
}

function sanitizeAsciiText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 127) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

export function buildCapturePullRequestBody(input: {
  rig: string;
  files: readonly CollectedObservationChange[];
  sourceSha: string;
  filter?: string;
  runUrl?: string;
}): string {
  const firstFile = input.files[0]?.path ?? 'packages/conformance/observations/';
  const fileBullets = input.files.map((f) => `- \`${f.path}\` (${f.kind})`).join('\n');
  const filterNote = input.filter ? ` (filter: \`${input.filter}\`)` : '';
  const runNote = input.runUrl ? `- Capture workflow run: ${input.runUrl}` : '- Capture workflow run: local/dispatch';

  const raw = [
    `Pins ${input.files.length} production Firebase observation file(s) captured by the \`${input.rig}\` oracle rig${filterNote} against the oracle project.`,
    '',
    '```bash',
    `# Verify registry and observation invariants against ${firstFile}`,
    'bun run compat:check',
    '```',
    '',
    `## ${input.rig} observations captured from main`,
    '',
    fileBullets,
    '',
    '## Risk',
    '',
    'Touches only static JSON files under `packages/conformance/observations/`. No runtime package code is modified, so there is no `test/apps/<name>` runtime path to add. Staged unlinked observations carry `rowIds: []` until the follow-up conformance PR links registry rows and replays verdicts.',
    '',
    '<details>',
    '<summary>Implementation notes</summary>',
    '',
    `- Source \`main\` commit: \`${input.sourceSha}\``,
    `- Oracle rig: \`${input.rig}\``,
    runNote,
    '',
    '</details>',
    '',
  ].join('\n');

  return sanitizeAsciiText(raw);
}

export async function verifyAndOpenCapturePullRequests(options: {
  cwd: string;
  artifactDir: string;
  repository: string;
  gh: Gh;
  fallbackGh?: Gh;
  hasPatPushAuth?: boolean;
}): Promise<OpenedPullRequestOutcome[]> {
  const { cwd, artifactDir, repository, gh } = options;
  const hasPatPushAuth = options.hasPatPushAuth ?? true;
  const allBundleFiles = assertNoSymlinksAndCollectRegularFiles(artifactDir);
  if (!allBundleFiles.includes('manifest.json')) {
    throw new Error('Artifact bundle is missing manifest.json');
  }

  const manifest = JSON.parse(
    readFileSync(join(artifactDir, 'manifest.json'), 'utf8'),
  ) as CaptureBundleManifest;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.rigs)) {
    throw new Error('Invalid manifest.json in artifact bundle');
  }

  const rigManifests = await loadRigManifests();
  const validRigIds = new Set(rigManifests.map((m) => m.id));

  const expectedBundleFiles = new Set<string>(['manifest.json']);
  for (const entry of manifest.rigs) {
    if (!SAFE_RIG_ID.test(entry.rig) || !validRigIds.has(entry.rig)) {
      throw new Error(`Manifest names invalid or unknown rig '${String(entry.rig)}'`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`Manifest entry for '${entry.rig}' has no observation files`);
    }
    for (const file of entry.files) {
      validateObservationRelativePath(file.path);
      const bundleRel = `rigs/${entry.rig}/${file.path}`;
      expectedBundleFiles.add(bundleRel);
      const fullPath = join(artifactDir, bundleRel);
      if (!existsSync(fullPath)) {
        throw new Error(`Manifest observation '${bundleRel}' is missing from artifact bundle`);
      }
      assertValidObservationEnvelope(file.path, readFileSync(fullPath, 'utf8'));
    }
  }

  for (const actual of allBundleFiles) {
    if (!expectedBundleFiles.has(actual)) {
      throw new Error(`Unexpected file in artifact bundle: '${actual}'`);
    }
  }

  execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd });
  execFileSync(
    'git',
    ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    { cwd },
  );

  const scratch = mkdtempSync(join(tmpdir(), 'oracle-capture-pr-body-'));
  const outcomes: OpenedPullRequestOutcome[] = [];

  const prAuth: PullRequestAuth = {
    primaryGh: gh,
    fallbackGh: options.fallbackGh,
    hasPatPushAuth,
  };

  try {
    for (const entry of manifest.rigs) {
      const canonicalBranch = `chore/oracle-capture-${entry.rig}`;
      execFileSync('git', ['checkout', '--detach', 'origin/main'], { cwd });

      for (const file of entry.files) {
        const src = join(artifactDir, 'rigs', entry.rig, file.path);
        const dest = join(cwd, file.path);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }

      const meaningfulFiles = entry.files.filter((file) => {
        let baseText: string | null = null;
        try {
          baseText = execFileSync('git', ['show', `origin/main:${file.path}`], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch {
          baseText = null;
        }
        const nextText = readFileSync(join(cwd, file.path), 'utf8');
        if (baseText !== null && canonicalizeObservation(baseText) === canonicalizeObservation(nextText)) {
          execFileSync('git', ['checkout', '--', file.path], { cwd });
          return false;
        }
        return true;
      });

      if (meaningfulFiles.length === 0) {
        outcomes.push({ rig: entry.rig, branch: canonicalBranch, action: 'unchanged', prUrl: '' });
        continue;
      }

      const { branch, divertedFromBranch } = resolveCaptureTargetBranch({
        repository,
        rig: entry.rig,
        sourceSha: manifest.sourceSha,
        auth: prAuth,
      });
      if (divertedFromBranch !== null) {
        preserveIdenticalProtectedObservations(cwd, divertedFromBranch, meaningfulFiles);
      }

      execFileSync('git', ['checkout', '-B', branch], { cwd });
      execFileSync('git', ['add', '--', ...meaningfulFiles.map((f) => f.path)], { cwd });
      assertStagedPathsAreObservationsOnly(cwd);
      const title = sanitizeAsciiText(`chore(conformance): capture ${entry.rig} oracle observations`);
      execFileSync('git', ['commit', '-m', title], { cwd });
      execFileSync('git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd });

      const bodyFile = join(scratch, `${entry.rig}-pr-body.md`);
      writeFileSync(
        bodyFile,
        buildCapturePullRequestBody({
          rig: entry.rig,
          files: meaningfulFiles,
          sourceSha: manifest.sourceSha,
          filter: entry.filter,
          runUrl: manifest.runUrl,
        }),
      );

      outcomes.push(
        createOrUpdatePullRequestWithFallback({
          cwd,
          target: {
            repository,
            rig: entry.rig,
            branch,
            title,
            bodyFile,
          },
          auth: prAuth,
        }),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return outcomes;
}

async function runPlanCli(env: NodeJS.ProcessEnv): Promise<void> {
  const planFile = env.PLAN_FILE;
  if (!planFile) throw new Error('PLAN_FILE environment variable is required');
  const plan = await planCaptureRun(env);
  mkdirSync(dirname(resolve(planFile)), { recursive: true });
  writeFileSync(resolve(planFile), `${JSON.stringify(plan, null, 2)}\n`);
  appendGithubOutput(env, 'should_run', String(plan.shouldRun));
  appendGithubOutput(env, 'needs_wif', String(plan.needsWif));
  appendGithubOutput(env, 'needs_parity_wif', String(Boolean(plan.needsParityWif)));
  appendGithubOutput(env, 'needs_capture_wif', String(Boolean(plan.needsCaptureWif)));
  appendGithubOutput(env, 'needs_chromium', String(Boolean(plan.needsChromium)));
  if (!plan.shouldRun) {
    console.log('[oracle-capture] No runnable uncaptured staged probes or pending rig prefixes; skipping.');
  } else {
    console.log(
      `[oracle-capture] Planned ${plan.invocations.length} invocation(s) (parity_wif=${String(Boolean(plan.needsParityWif))}, capture_wif=${String(Boolean(plan.needsCaptureWif))}).`,
    );
  }
}

async function runOpenPrCli(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  assertMainBranchContext(env);
  const artifactDir = env.ARTIFACT_DIR;
  const repository = env.GITHUB_REPOSITORY;
  if (!artifactDir || !repository) {
    throw new Error('ARTIFACT_DIR and GITHUB_REPOSITORY environment variables are required');
  }

  const patToken = (env.PAT_TOKEN ?? '').trim();
  const githubToken = (env.GITHUB_TOKEN ?? '').trim();
  let primaryGh: Gh;
  let fallbackGh: Gh | undefined;
  const hasPatPushAuth = patToken !== '';

  if (patToken !== '') {
    primaryGh = spawnGhWithToken(cwd, patToken);
    if (githubToken !== '' && githubToken !== patToken) {
      fallbackGh = spawnGhWithToken(cwd, githubToken);
    }
  } else if (githubToken !== '') {
    primaryGh = spawnGhWithToken(cwd, githubToken);
  } else {
    primaryGh = spawnGh(cwd);
  }

  const bundleDirs = resolveCaptureBundleDirs(resolve(artifactDir));
  const outcomes: OpenedPullRequestOutcome[] = [];
  for (const bundleDir of bundleDirs) {
    const legOutcomes = await verifyAndOpenCapturePullRequests({
      cwd,
      artifactDir: bundleDir,
      repository,
      gh: primaryGh,
      fallbackGh,
      hasPatPushAuth,
    });
    outcomes.push(...legOutcomes);
  }
  const summary = formatPullRequestOutcomesSummary(outcomes);
  appendStepSummary(env, summary);
  console.log(summary);
}

if (import.meta.main) {
  const subcommand = process.argv[2];
  if (subcommand === 'plan') {
    await runPlanCli(process.env);
  } else if (subcommand === 'capture') {
    await runCaptureCommand(process.cwd(), process.env);
  } else if (subcommand === 'open-pr') {
    await runOpenPrCli(process.cwd(), process.env);
  } else if (subcommand === 'reconcile-diverted') {
    await runReconcileDivertedCli(process.cwd(), process.env);
  } else {
    console.error('usage: bun scripts/ci/oracle-capture-pr.ts plan|capture|open-pr|reconcile-diverted');
    process.exit(2);
  }
}
