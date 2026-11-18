/**
 * Fail-closed reconciliation of superseded diverted `chore/oracle-capture-<rig>-<shortsha>`
 * pull requests after a push/capture run on `main` (`.github/workflows/oracle-capture.yml`).
 *
 * Only diverted capture branches (`chore/oracle-capture-<rig>-<shortsha>[-<n>]`) authored by
 * `github-actions[bot]` (or carrying a `github-actions[bot]` capture commit) are inspected.
 * Canonical `chore/oracle-capture-<rig>` branches and non-capture PRs are never touched.
 * A diverted PR is closed (and its remote branch CAS-deleted) ONLY when every changed path
 * in `merge-base(main, head)..head` is an added/modified file under
 * `packages/conformance/observations/**` that already exists on `origin/main` with identical
 * `behavior`, `description`, `fbSdkVersion`, `projectId`, and all other envelope fields
 * except `matrixRow`, `rowIds`, and `observedAt`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { loadRigManifests } from '../../packages/conformance/rigs/load.ts';
import type { Gh } from './github-issues.ts';
import { spawnGh } from './github-issues.ts';
import { spawnGhWithToken } from './oracle-capture-open-pr.ts';
import { appendStepSummary, assertMainBranchContext } from './oracle-capture-plan.ts';
import {
  assertValidObservationEnvelope,
  validateObservationRelativePath,
} from './oracle-observation-diff.ts';

const DIVERTED_SUFFIX_RE = /^(?:[0-9a-f]{7,40}|capture)(?:-[1-9]\d*)?$/;
const BOT_GIT_IDENTITY = 'github-actions[bot]<41898282+github-actions[bot]@users.noreply.github.com>';
const ALLOWED_ENVELOPE_DIFF_KEYS = new Set(['matrixRow', 'rowIds', 'observedAt']);

export interface OpenCapturePrCandidate {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author?: {
    login?: string | null;
    is_bot?: boolean | null;
  } | null;
  labels?: ReadonlyArray<{ name?: string | null }>;
}

export interface ReconciledDivertedPrOutcome {
  number: number;
  rig: string;
  branch: string;
  action: 'closed' | 'kept';
  reason: string;
  branchDeleted: boolean;
  comment?: string;
}

function toAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code <= 127) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && Array.isArray(value) === false) {
    const record = value as Record<string, unknown>;
    const sortedEntries = Object.keys(record)
      .sort()
      .map((k) => [k, record[k]] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

function stringifySorted(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

export function parseDivertedCaptureBranch(
  branch: string,
  validRigIds: ReadonlySet<string>,
): { rig: string; suffix: string } | null {
  const trimmed = branch.trim();
  if (trimmed.startsWith('chore/oracle-capture-') === false) {
    return null;
  }
  for (const rig of validRigIds) {
    const prefix = `chore/oracle-capture-${rig}-`;
    if (trimmed.startsWith(prefix)) {
      const suffix = trimmed.slice(prefix.length);
      if (DIVERTED_SUFFIX_RE.test(suffix)) {
        return { rig, suffix };
      }
    }
  }
  return null;
}

function hasMergeQueueLabel(pr: OpenCapturePrCandidate): boolean {
  if (Array.isArray(pr.labels) === false) {
    return false;
  }
  for (const label of pr.labels) {
    const rawName = label?.name;
    if (typeof rawName === 'string' && rawName.trim().toLowerCase() === 'merge-queue') {
      return true;
    }
  }
  return false;
}

function isTrustedCapturePr(
  pr: OpenCapturePrCandidate,
  rig: string,
  tipCommitIdentity: string,
): boolean {
  const expectedTitle = `chore(conformance): capture ${rig} oracle observations`;
  if (pr.title.trim() !== expectedTitle) {
    return false;
  }
  const login = pr.author?.login ?? '';
  if (login === 'app/github-actions' || login === 'github-actions[bot]') {
    return true;
  }
  return tipCommitIdentity.trim() === BOT_GIT_IDENTITY;
}

function stripAllowedLinkFields(record: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ALLOWED_ENVELOPE_DIFF_KEYS.has(key)) {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}

export function areObservationsSupersededEquivalent(
  obsPath: string,
  prContent: string,
  mainContent: string,
): { equivalent: boolean; reason: string } {
  try {
    assertValidObservationEnvelope(obsPath, prContent);
    assertValidObservationEnvelope(obsPath, mainContent);
  } catch (error) {
    let detail = String(error);
    if (error instanceof Error) {
      detail = error.message;
    }
    return { equivalent: false, reason: `invalid-envelope (${detail})` };
  }

  const prRecord = JSON.parse(prContent) as Record<string, unknown>;
  const mainRecord = JSON.parse(mainContent) as Record<string, unknown>;

  if (prRecord.description !== mainRecord.description) {
    return { equivalent: false, reason: 'description-diff' };
  }
  if (prRecord.fbSdkVersion !== mainRecord.fbSdkVersion) {
    return { equivalent: false, reason: 'fbSdkVersion-diff' };
  }
  if (prRecord.projectId !== mainRecord.projectId) {
    return { equivalent: false, reason: 'projectId-diff' };
  }
  if (stringifySorted(prRecord.behavior) !== stringifySorted(mainRecord.behavior)) {
    return { equivalent: false, reason: 'behavior-diff' };
  }
  const prStripped = stringifySorted(stripAllowedLinkFields(prRecord));
  const mainStripped = stringifySorted(stripAllowedLinkFields(mainRecord));
  if (prStripped !== mainStripped) {
    return { equivalent: false, reason: 'envelope-diff' };
  }
  return { equivalent: true, reason: 'equivalent' };
}

function callGhWithFallback(primaryGh: Gh, fallbackGh: Gh | undefined, args: string[]): string {
  try {
    return primaryGh(args);
  } catch (error) {
    if (fallbackGh === undefined) {
      throw error;
    }
    return fallbackGh(args);
  }
}

function gitShowBlobOrNull(cwd: string, commitSha: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['show', `${commitSha}:${relPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

interface DiffEntry {
  status: string;
  path: string;
}

function diffBranchAgainstMergeBase(
  cwd: string,
  mergeBaseSha: string,
  tipSha: string,
): DiffEntry[] {
  const raw = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', `${mergeBaseSha}..${tipSha}`],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const tokens = raw.split('\0');
  if (tokens.at(-1) === '') {
    tokens.pop();
  }
  const entries: DiffEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index] ?? '';
    index += 1;
    if (status === '') {
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const _oldPath = tokens[index] ?? '';
      const newPath = tokens[index + 1] ?? '';
      index += 2;
      entries.push({ status, path: newPath });
    } else {
      const path = tokens[index] ?? '';
      index += 1;
      entries.push({ status, path });
    }
  }
  return entries;
}

function summarizeLandingCommits(
  cwd: string,
  mainSha: string,
  paths: readonly string[],
): string {
  try {
    const raw = execFileSync(
      'git',
      ['log', '--first-parent', '--oneline', '-n', '3', mainSha, '--', ...paths],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (raw === '') {
      return mainSha.slice(0, 10);
    }
    const items = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return toAscii(items.join('; '));
  } catch {
    return mainSha.slice(0, 10);
  }
}

function deleteRemoteDivertedBranchSafely(
  cwd: string,
  repository: string,
  branch: string,
  expectedOid: string,
  primaryGh: Gh,
  fallbackGh: Gh | undefined,
): boolean {
  const leasePush = spawnSync(
    'git',
    [
      'push',
      `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
      'origin',
      `:refs/heads/${branch}`,
    ],
    { cwd, encoding: 'utf8' },
  );
  if (leasePush.status === 0) {
    return true;
  }
  try {
    const refRaw = callGhWithFallback(primaryGh, fallbackGh, [
      'api',
      `repos/${repository}/git/ref/heads/${branch}`,
    ]);
    const parsed = JSON.parse(refRaw) as { object?: { sha?: string } };
    if (parsed.object?.sha !== expectedOid) {
      return false;
    }
    callGhWithFallback(primaryGh, fallbackGh, [
      'api',
      '-X',
      'DELETE',
      `repos/${repository}/git/refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function reconcileSupersededDivertedCapturePrs(options: {
  cwd: string;
  repository: string;
  primaryGh: Gh;
  fallbackGh?: Gh;
  validRigIds?: ReadonlySet<string>;
}): Promise<{ mainSha: string; outcomes: ReconciledDivertedPrOutcome[] }> {
  const { cwd, repository, primaryGh, fallbackGh } = options;
  let validRigIds = options.validRigIds;
  if (validRigIds === undefined) {
    const manifests = await loadRigManifests();
    validRigIds = new Set(manifests.map((m) => m.id));
  }

  execFileSync('git', ['fetch', '--no-tags', 'origin', 'refs/heads/main'], {
    cwd,
    stdio: 'ignore',
  });
  const mainSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();

  const openPrs = JSON.parse(
    callGhWithFallback(primaryGh, fallbackGh, [
      'pr',
      'list',
      '--repo',
      repository,
      '--base',
      'main',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,url,title,headRefName,headRefOid,baseRefName,author,labels',
    ]),
  ) as OpenCapturePrCandidate[];

  const outcomes: ReconciledDivertedPrOutcome[] = [];
  for (const pr of openPrs) {
    if (pr.baseRefName !== 'main') {
      continue;
    }
    const parsedBranch = parseDivertedCaptureBranch(pr.headRefName, validRigIds);
    if (parsedBranch === null) {
      continue;
    }
    const { rig } = parsedBranch;
    const branch = pr.headRefName.trim();

    if (hasMergeQueueLabel(pr)) {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: 'labeled-merge-queue',
        branchDeleted: false,
      });
      continue;
    }

    const fetchBranch = spawnSync(
      'git',
      ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`],
      { cwd, stdio: 'ignore' },
    );
    if (fetchBranch.status !== 0) {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: 'remote-branch-missing',
        branchDeleted: false,
      });
      continue;
    }

    const fetchedTipSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (fetchedTipSha !== pr.headRefOid) {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: 'head-oid-changed',
        branchDeleted: false,
      });
      continue;
    }

    const tipIdentity = execFileSync(
      'git',
      ['show', '-s', '--format=%an<%ae>', fetchedTipSha],
      { cwd, encoding: 'utf8' },
    ).trim();
    if (isTrustedCapturePr(pr, rig, tipIdentity) === false) {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: 'untrusted-author-or-title',
        branchDeleted: false,
      });
      continue;
    }

    const mergeBaseSha = execFileSync(
      'git',
      ['merge-base', mainSha, fetchedTipSha],
      { cwd, encoding: 'utf8' },
    ).trim();
    const diffEntries = diffBranchAgainstMergeBase(cwd, mergeBaseSha, fetchedTipSha);
    if (diffEntries.length === 0) {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: 'empty-diff',
        branchDeleted: false,
      });
      continue;
    }

    let rejectReason = '';
    const verifiedPaths: string[] = [];
    for (const entry of diffEntries) {
      if (entry.status !== 'A' && entry.status !== 'M') {
        rejectReason = `disallowed-status:${entry.status}:${entry.path}`;
        break;
      }
      try {
        validateObservationRelativePath(entry.path);
      } catch {
        rejectReason = `non-observation-path:${entry.path}`;
        break;
      }
      const mainBlob = gitShowBlobOrNull(cwd, mainSha, entry.path);
      if (mainBlob === null) {
        rejectReason = `unmerged-file:${entry.path}`;
        break;
      }
      const prBlob = gitShowBlobOrNull(cwd, fetchedTipSha, entry.path);
      if (prBlob === null) {
        rejectReason = `unreadable-pr-file:${entry.path}`;
        break;
      }
      const eq = areObservationsSupersededEquivalent(entry.path, prBlob, mainBlob);
      if (eq.equivalent === false) {
        rejectReason = `${eq.reason}:${entry.path}`;
        break;
      }
      verifiedPaths.push(entry.path);
    }

    if (rejectReason !== '') {
      outcomes.push({
        number: pr.number,
        rig,
        branch,
        action: 'kept',
        reason: rejectReason,
        branchDeleted: false,
      });
      continue;
    }

    const landingSummary = summarizeLandingCommits(cwd, mainSha, verifiedPaths);
    const comment = toAscii(
      `Superseded on main (${mainSha.slice(0, 10)}): all ${String(verifiedPaths.length)} observation file(s) in this diverted capture branch already exist on main with identical behavior, description, SDK version, and projectId (landed via ${landingSummary}).`,
    );

    callGhWithFallback(primaryGh, fallbackGh, [
      'api',
      '-X',
      'POST',
      `repos/${repository}/issues/${String(pr.number)}/comments`,
      '-f',
      `body=${comment}`,
    ]);
    callGhWithFallback(primaryGh, fallbackGh, [
      'api',
      '-X',
      'PATCH',
      `repos/${repository}/pulls/${String(pr.number)}`,
      '-f',
      'state=closed',
    ]);
    const branchDeleted = deleteRemoteDivertedBranchSafely(
      cwd,
      repository,
      branch,
      pr.headRefOid,
      primaryGh,
      fallbackGh,
    );
    outcomes.push({
      number: pr.number,
      rig,
      branch,
      action: 'closed',
      reason: 'superseded-on-main',
      branchDeleted,
      comment,
    });
  }

  return { mainSha, outcomes };
}

export function formatReconciledDivertedSummary(
  mainSha: string,
  outcomes: readonly ReconciledDivertedPrOutcome[],
): string {
  if (outcomes.length === 0) {
    return `## Diverted capture PR reconciliation (\`${mainSha.slice(0, 10)}\`)\n\nNo open diverted \`chore/oracle-capture-<rig>-<shortsha>\` pull requests found.`;
  }
  const lines = outcomes.map((item) => {
    if (item.action === 'closed') {
      let branchNote = 'remote branch retained';
      if (item.branchDeleted) {
        branchNote = 'remote branch deleted';
      }
      return `- **#${String(item.number)}** (\`${item.branch}\`): closed as superseded (${branchNote})`;
    }
    return `- **#${String(item.number)}** (\`${item.branch}\`): kept open (${item.reason})`;
  });
  return [
    `## Diverted capture PR reconciliation (\`${mainSha.slice(0, 10)}\`)`,
    '',
    ...lines,
  ].join('\n');
}

function readEnvTrimmed(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key] ?? '';
  return raw.trim();
}

export async function runReconcileDivertedCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertMainBranchContext(env);
  const repository = readEnvTrimmed(env, 'GITHUB_REPOSITORY');
  if (repository === '') {
    throw new Error('GITHUB_REPOSITORY environment variable is required');
  }
  const githubToken = readEnvTrimmed(env, 'GITHUB_TOKEN');
  const patToken = readEnvTrimmed(env, 'PAT_TOKEN');
  let primaryGh: Gh;
  let fallbackGh: Gh | undefined;
  if (githubToken !== '') {
    primaryGh = spawnGhWithToken(cwd, githubToken);
    if (patToken !== '' && patToken !== githubToken) {
      fallbackGh = spawnGhWithToken(cwd, patToken);
    }
  } else if (patToken !== '') {
    primaryGh = spawnGhWithToken(cwd, patToken);
  } else {
    primaryGh = spawnGh(cwd);
  }

  const { mainSha, outcomes } = await reconcileSupersededDivertedCapturePrs({
    cwd,
    repository,
    primaryGh,
    fallbackGh,
  });
  const summary = formatReconciledDivertedSummary(mainSha, outcomes);
  appendStepSummary(env, summary);
  console.log(summary);
}
