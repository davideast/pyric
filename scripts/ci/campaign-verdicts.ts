#!/usr/bin/env bun
// Evaluates SHA-pinned two-axis Advisor campaign review verdicts on a pull
// request and adds the `merge-queue` label only when both `spec` and
// `standards` carry a trusted `MERGE` verdict for the current head SHA with no
// later `FIX` verdict.

import { appendFileSync } from 'node:fs';
import {
  formatErrorMessage,
  normalizeCommitSha,
  parsePositiveInteger,
  resolveDefaultRepo,
  runGhCommand,
  type CampaignAxis,
  type CampaignVerdict,
  type VerdictMarkerInput,
} from './campaign-verdict.ts';
import { QUEUE_LABEL } from './merge-queue.ts';

export const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const DEFAULT_MAX_COMMENT_PAGES = 50;

export interface CampaignPullState {
  number: number;
  state: string;
  isDraft: boolean;
  baseRef: string;
  headSha: string;
  headRepoFullName: string;
  labels: readonly string[];
}

export interface CampaignComment {
  id: number;
  authorAssociation: string;
  body: string;
}

export interface CampaignVerdictFacts {
  repo: string;
  pull: CampaignPullState;
  comments: readonly CampaignComment[];
}

export type CampaignDecisionReason =
  | 'ready'
  | 'not-open'
  | 'wrong-base'
  | 'fork-pull-request'
  | 'draft'
  | 'already-labeled'
  | 'fix-verdict'
  | 'missing-verdict';

export interface CampaignVerdictDecision {
  shouldLabel: boolean;
  reason: CampaignDecisionReason;
  headSha: string;
  latestByAxis: {
    spec: CampaignVerdict | undefined;
    standards: CampaignVerdict | undefined;
  };
  staleVerdictCount: number;
  untrustedVerdictCount: number;
}

export interface CampaignVerdictsIo {
  repo: string;
  gh: (args: string[]) => string;
  log: (text: string) => void;
}

interface PullApiResponse {
  number: number;
  state: string;
  draft: boolean;
  base: { ref: string };
  head: { sha: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
}

interface CommentApiItem {
  id: number;
  author_association?: string | null;
  body?: string | null;
}

const STANDALONE_MARKER =
  /^ {0,3}<!--\s*campaign-verdict\s+axis=(spec|standards)\s+verdict=(MERGE|FIX)\s+sha=([0-9a-fA-F]{40})\s*-->[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function closingFenceMatches(line: string, fenceChar: string, fenceLength: number): boolean {
  if (line.startsWith('    ')) return false;
  const trimmedStart = line.replace(/^ {0,3}/, '');
  let runLength = 0;
  while (runLength < trimmedStart.length && trimmedStart[runLength] === fenceChar) {
    runLength++;
  }
  if (runLength < fenceLength) return false;
  const trailing = trimmedStart.slice(runLength);
  return /^[ \t]*$/.test(trailing);
}

export function parseVerdictMarkers(body: string): VerdictMarkerInput[] {
  const markers: VerdictMarkerInput[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let activeFence: { char: string; length: number } | undefined;

  for (const line of lines) {
    if (activeFence !== undefined) {
      if (closingFenceMatches(line, activeFence.char, activeFence.length)) {
        activeFence = undefined;
      }
      continue;
    }

    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch !== null) {
      const delimiter = fenceMatch[1] ?? '';
      const info = fenceMatch[2] ?? '';
      const fenceChar = delimiter[0] ?? '';
      const backtickFenceWithInlineTick = fenceChar === '`' && info.includes('`');
      if (!backtickFenceWithInlineTick && fenceChar !== '') {
        activeFence = { char: fenceChar, length: delimiter.length };
        continue;
      }
    }

    const match = STANDALONE_MARKER.exec(line);
    if (match === null) continue;
    const axis = match[1] as CampaignAxis;
    const verdict = match[2] as CampaignVerdict;
    const sha = normalizeCommitSha(match[3] ?? '');
    markers.push({ axis, verdict, sha });
  }

  return markers;
}

function emptyAxisState(): CampaignVerdictDecision['latestByAxis'] {
  return { spec: undefined, standards: undefined };
}

function earlyReject(
  reason: Exclude<CampaignDecisionReason, 'ready' | 'fix-verdict' | 'missing-verdict'>,
  headSha: string,
): CampaignVerdictDecision {
  return {
    shouldLabel: false,
    reason,
    headSha,
    latestByAxis: emptyAxisState(),
    staleVerdictCount: 0,
    untrustedVerdictCount: 0,
  };
}

function isSameRepo(headRepoFullName: string, targetRepo: string): boolean {
  if (headRepoFullName === '' || targetRepo === '') return false;
  return headRepoFullName.toLowerCase() === targetRepo.toLowerCase();
}

export function evaluateCampaignVerdicts(facts: CampaignVerdictFacts): CampaignVerdictDecision {
  const headSha = normalizeCommitSha(facts.pull.headSha);
  if (facts.pull.state !== 'open') return earlyReject('not-open', headSha);
  if (facts.pull.baseRef !== 'main') return earlyReject('wrong-base', headSha);
  if (!isSameRepo(facts.pull.headRepoFullName, facts.repo)) {
    return earlyReject('fork-pull-request', headSha);
  }
  if (facts.pull.isDraft) return earlyReject('draft', headSha);
  if (facts.pull.labels.includes(QUEUE_LABEL)) return earlyReject('already-labeled', headSha);

  const orderedComments = [...facts.comments].sort((left, right) => left.id - right.id);
  const latestByAxis = emptyAxisState();
  let staleVerdictCount = 0;
  let untrustedVerdictCount = 0;

  for (const comment of orderedComments) {
    const markers = parseVerdictMarkers(comment.body);
    if (markers.length === 0) continue;
    if (!TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.authorAssociation)) {
      untrustedVerdictCount += markers.length;
      continue;
    }
    for (const marker of markers) {
      if (marker.sha !== headSha) {
        staleVerdictCount++;
        continue;
      }
      latestByAxis[marker.axis] = marker.verdict;
    }
  }

  const hasFix = latestByAxis.spec === 'FIX' || latestByAxis.standards === 'FIX';
  if (hasFix) {
    return {
      shouldLabel: false,
      reason: 'fix-verdict',
      headSha,
      latestByAxis,
      staleVerdictCount,
      untrustedVerdictCount,
    };
  }

  const bothApproved = latestByAxis.spec === 'MERGE' && latestByAxis.standards === 'MERGE';
  if (!bothApproved) {
    return {
      shouldLabel: false,
      reason: 'missing-verdict',
      headSha,
      latestByAxis,
      staleVerdictCount,
      untrustedVerdictCount,
    };
  }

  return {
    shouldLabel: true,
    reason: 'ready',
    headSha,
    latestByAxis,
    staleVerdictCount,
    untrustedVerdictCount,
  };
}

function pageQuery(page: number): string {
  if (page === 1) return 'per_page=100';
  return `per_page=100&page=${page}`;
}

function fetchPullState(io: CampaignVerdictsIo, prNumber: number): CampaignPullState {
  const raw = io.gh(['api', `repos/${io.repo}/pulls/${prNumber}`]);
  const parsed = JSON.parse(raw) as PullApiResponse;
  return {
    number: parsed.number,
    state: parsed.state,
    isDraft: parsed.draft,
    baseRef: parsed.base.ref,
    headSha: parsed.head.sha,
    headRepoFullName: parsed.head.repo?.full_name ?? '',
    labels: parsed.labels.map((label) => label.name),
  };
}

function fetchPullComments(
  io: CampaignVerdictsIo,
  prNumber: number,
  maxPages: number,
): CampaignComment[] {
  const comments: CampaignComment[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = io.gh(['api', `repos/${io.repo}/issues/${prNumber}/comments?${pageQuery(page)}`]);
    const batch = JSON.parse(raw) as CommentApiItem[];
    for (const item of batch) {
      comments.push({
        id: item.id,
        authorAssociation: item.author_association ?? '',
        body: item.body ?? '',
      });
    }
    if (batch.length < 100) return comments;
  }
  throw new Error(
    `Refusing to evaluate truncated comment history on PR #${prNumber} (> ${maxPages * 100} comments).`,
  );
}

function formatDecisionSummary(
  prNumber: number,
  decision: CampaignVerdictDecision,
  dryRun: boolean,
): string {
  const specState = decision.latestByAxis.spec ?? 'none';
  const standardsState = decision.latestByAxis.standards ?? 'none';
  if (decision.shouldLabel) {
    let actionText = `Added ${QUEUE_LABEL}`;
    if (dryRun) {
      actionText = `Dry run: would add ${QUEUE_LABEL}`;
    }
    return `${actionText} to #${prNumber} at ${decision.headSha} (spec=${specState}, standards=${standardsState}).`;
  }
  return `Skipped ${QUEUE_LABEL} on #${prNumber} at ${decision.headSha}: ${decision.reason} (spec=${specState}, standards=${standardsState}, stale=${decision.staleVerdictCount}, untrusted=${decision.untrustedVerdictCount}).`;
}

export function reconcileCampaignVerdicts(
  io: CampaignVerdictsIo,
  prNumber: number,
  options: { dryRun?: boolean; maxCommentPages?: number } = {},
): CampaignVerdictDecision {
  const dryRun = options.dryRun === true;
  const maxPages = options.maxCommentPages ?? DEFAULT_MAX_COMMENT_PAGES;
  const pull = fetchPullState(io, prNumber);
  const precheck = evaluateCampaignVerdicts({ repo: io.repo, pull, comments: [] });
  if (precheck.reason !== 'missing-verdict') {
    io.log(formatDecisionSummary(prNumber, precheck, dryRun));
    return precheck;
  }

  const comments = fetchPullComments(io, prNumber, maxPages);
  const decision = evaluateCampaignVerdicts({ repo: io.repo, pull, comments });
  if (decision.shouldLabel && !dryRun) {
    io.gh([
      'api',
      '-X',
      'POST',
      `repos/${io.repo}/issues/${prNumber}/labels`,
      '-f',
      `labels[]=${QUEUE_LABEL}`,
    ]);
  }
  io.log(formatDecisionSummary(prNumber, decision, dryRun));
  return decision;
}

function defaultIo(repo: string): CampaignVerdictsIo {
  return {
    repo,
    gh: (args) => runGhCommand(args),
    log: (text) => {
      console.log(text);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, `${text}\n`);
    },
  };
}

if (import.meta.main) {
  try {
    const repo = resolveDefaultRepo(process.env);
    if (repo === undefined) {
      throw new Error('GITHUB_REPOSITORY is required.');
    }
    const prNumber = parsePositiveInteger(process.env.PR_NUMBER, 'PR_NUMBER');
    const dryRun = process.env.DRY_RUN === 'true';
    reconcileCampaignVerdicts(defaultIo(repo), prNumber, { dryRun });
  } catch (error) {
    console.error(formatErrorMessage(error));
    process.exit(2);
  }
}
