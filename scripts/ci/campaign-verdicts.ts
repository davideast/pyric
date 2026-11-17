#!/usr/bin/env bun
// Reconciles SHA-pinned two-axis Advisor campaign review verdicts on a pull
// request (`add-label`, `remove-label`, or `noop` for `merge-queue`) and
// dispatches `merge-queue.yml` whenever `merge-queue` is added or removed.

import { appendFileSync, readFileSync } from 'node:fs';
import {
  normalizeCommitSha,
  parseCommentVerdictTokens,
  type CampaignAxis,
  type CampaignVerdict,
  type VerdictMarkerInput,
} from './campaign-verdict-markers.ts';
import {
  formatErrorMessage,
  parsePositiveInteger,
  resolveDefaultRepo,
  runGhCommand,
} from './campaign-verdict.ts';
import { QUEUE_LABEL } from './merge-queue.ts';

export const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const MERGE_QUEUE_WORKFLOW = 'merge-queue.yml';
const DEFAULT_MAX_COMMENT_PAGES = 50;
const LABEL_NOT_FOUND = /\b404\b|label does not exist/i;

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
  userType?: string;
  updatedAt?: string;
  createdAt?: string;
  body: string;
}

export interface CampaignVerdictFacts {
  repo: string;
  pull: CampaignPullState;
  comments: readonly CampaignComment[];
  triggerHadTrustedVerdict?: boolean;
}

export type CampaignDecisionAction = 'add-label' | 'remove-label' | 'noop';

export type CampaignDecisionReason =
  | 'ready'
  | 'already-labeled'
  | 'not-open'
  | 'wrong-base'
  | 'fork-pull-request'
  | 'draft'
  | 'malformed-verdict'
  | 'fix-verdict'
  | 'missing-verdict';

export interface CampaignVerdictDecision {
  action: CampaignDecisionAction;
  reason: CampaignDecisionReason;
  hasTrustedVerdictHistory: boolean;
  headSha: string;
  latestByAxis: {
    spec: CampaignVerdict | undefined;
    standards: CampaignVerdict | undefined;
  };
  staleVerdictCount: number;
  untrustedVerdictCount: number;
  malformedVerdictCount: number;
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
  user?: { type?: string | null } | null;
  updated_at?: string | null;
  created_at?: string | null;
  body?: string | null;
}

interface IssueCommentEventPayload {
  action?: string;
  comment?: {
    author_association?: string | null;
    user?: { type?: string | null } | null;
    body?: string | null;
  } | null;
  changes?: {
    body?: {
      from?: string | null;
    } | null;
  } | null;
}

function emptyAxisState(): CampaignVerdictDecision['latestByAxis'] {
  return { spec: undefined, standards: undefined };
}

function isSameRepo(headRepoFullName: string, targetRepo: string): boolean {
  if (headRepoFullName === '' || targetRepo === '') return false;
  return headRepoFullName.toLowerCase() === targetRepo.toLowerCase();
}

function isTrustedHumanAuthor(
  authorAssociation: string,
  userType: string | undefined,
): boolean {
  if (userType !== undefined && userType.toLowerCase() === 'bot') {
    return false;
  }
  return TRUSTED_AUTHOR_ASSOCIATIONS.has(authorAssociation);
}

function commentTimestampMs(comment: CampaignComment): number {
  const rawTimestamp = comment.updatedAt ?? comment.createdAt;
  if (rawTimestamp === undefined || rawTimestamp === '') return 0;
  const parsed = Date.parse(rawTimestamp);
  if (Number.isNaN(parsed)) return 0;
  return parsed;
}

function compareCommentsChronologically(
  left: CampaignComment,
  right: CampaignComment,
): number {
  const delta = commentTimestampMs(left) - commentTimestampMs(right);
  if (delta !== 0) return delta;
  return left.id - right.id;
}

function resolveSingleCommentAxisVerdict(
  markers: readonly VerdictMarkerInput[],
  axis: CampaignAxis,
): CampaignVerdict | undefined {
  let sawMerge = false;
  for (const marker of markers) {
    if (marker.axis !== axis) continue;
    if (marker.verdict === 'FIX') return 'FIX';
    sawMerge = true;
  }
  if (sawMerge) return 'MERGE';
  return undefined;
}

function containsAnyVerdictToken(body: string): boolean {
  const parsed = parseCommentVerdictTokens(body);
  return parsed.markers.length + parsed.malformedMarkers.length > 0;
}

export function detectTrustedTriggerVerdict(
  eventName: string | undefined,
  eventPayload: unknown,
): boolean {
  if (eventName !== 'issue_comment') return false;
  if (typeof eventPayload !== 'object' || eventPayload === null) return false;
  const payload = eventPayload as IssueCommentEventPayload;
  if (payload.action !== 'edited' && payload.action !== 'deleted') return false;
  const comment = payload.comment;
  if (comment === null || comment === undefined) return false;
  const association = comment.author_association ?? '';
  const userType = comment.user?.type ?? undefined;
  if (!isTrustedHumanAuthor(association, userType)) return false;
  const currentBody = comment.body ?? '';
  const previousBody = payload.changes?.body?.from ?? '';
  return containsAnyVerdictToken(currentBody) || containsAnyVerdictToken(previousBody);
}

function decideIneligibleAction(
  currentlyLabeled: boolean,
  hasTrustedVerdictHistory: boolean,
  isOpen: boolean,
): CampaignDecisionAction {
  if (!isOpen) return 'noop';
  if (currentlyLabeled && hasTrustedVerdictHistory) return 'remove-label';
  return 'noop';
}

export function evaluateCampaignVerdicts(facts: CampaignVerdictFacts): CampaignVerdictDecision {
  const headSha = normalizeCommitSha(facts.pull.headSha);
  const orderedComments = [...facts.comments].sort(compareCommentsChronologically);
  const latestByAxis = emptyAxisState();
  let staleVerdictCount = 0;
  let untrustedVerdictCount = 0;
  let malformedVerdictCount = 0;
  let trustedVerdictTokenCount = 0;

  for (const comment of orderedComments) {
    const tokens = parseCommentVerdictTokens(comment.body);
    const totalTokens = tokens.markers.length + tokens.malformedMarkers.length;
    if (totalTokens === 0) continue;

    if (!isTrustedHumanAuthor(comment.authorAssociation, comment.userType)) {
      untrustedVerdictCount += totalTokens;
      continue;
    }

    trustedVerdictTokenCount += totalTokens;
    malformedVerdictCount += tokens.malformedMarkers.length;

    const headMarkers: VerdictMarkerInput[] = [];
    for (const marker of tokens.markers) {
      if (marker.sha !== headSha) {
        staleVerdictCount++;
      } else {
        headMarkers.push(marker);
      }
    }

    const specVerdict = resolveSingleCommentAxisVerdict(headMarkers, 'spec');
    if (specVerdict !== undefined) latestByAxis.spec = specVerdict;
    const standardsVerdict = resolveSingleCommentAxisVerdict(headMarkers, 'standards');
    if (standardsVerdict !== undefined) latestByAxis.standards = standardsVerdict;
  }

  const hasTrustedVerdictHistory =
    trustedVerdictTokenCount > 0 || facts.triggerHadTrustedVerdict === true;
  const currentlyLabeled = facts.pull.labels.includes(QUEUE_LABEL);
  const isOpen = facts.pull.state === 'open';

  let ineligibleReason: Exclude<CampaignDecisionReason, 'ready' | 'already-labeled'> | undefined;
  if (!isOpen) {
    ineligibleReason = 'not-open';
  } else if (!isSameRepo(facts.pull.headRepoFullName, facts.repo)) {
    ineligibleReason = 'fork-pull-request';
  } else if (facts.pull.baseRef !== 'main') {
    ineligibleReason = 'wrong-base';
  } else if (facts.pull.isDraft) {
    ineligibleReason = 'draft';
  } else if (malformedVerdictCount > 0) {
    ineligibleReason = 'malformed-verdict';
  } else if (latestByAxis.spec === 'FIX' || latestByAxis.standards === 'FIX') {
    ineligibleReason = 'fix-verdict';
  } else if (latestByAxis.spec !== 'MERGE' || latestByAxis.standards !== 'MERGE') {
    ineligibleReason = 'missing-verdict';
  }

  if (ineligibleReason !== undefined) {
    return {
      action: decideIneligibleAction(currentlyLabeled, hasTrustedVerdictHistory, isOpen),
      reason: ineligibleReason,
      hasTrustedVerdictHistory,
      headSha,
      latestByAxis,
      staleVerdictCount,
      untrustedVerdictCount,
      malformedVerdictCount,
    };
  }

  if (currentlyLabeled) {
    return {
      action: 'noop',
      reason: 'already-labeled',
      hasTrustedVerdictHistory,
      headSha,
      latestByAxis,
      staleVerdictCount,
      untrustedVerdictCount,
      malformedVerdictCount,
    };
  }

  return {
    action: 'add-label',
    reason: 'ready',
    hasTrustedVerdictHistory,
    headSha,
    latestByAxis,
    staleVerdictCount,
    untrustedVerdictCount,
    malformedVerdictCount,
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
      const entry: CampaignComment = {
        id: item.id,
        authorAssociation: item.author_association ?? '',
        body: item.body ?? '',
      };
      const userType = item.user?.type;
      if (userType !== undefined && userType !== null) entry.userType = userType;
      if (item.updated_at !== undefined && item.updated_at !== null) {
        entry.updatedAt = item.updated_at;
      }
      if (item.created_at !== undefined && item.created_at !== null) {
        entry.createdAt = item.created_at;
      }
      comments.push(entry);
    }
    if (batch.length < 100) return comments;
  }
  throw new Error(
    `Refusing to evaluate truncated comment history on PR #${prNumber} (> ${maxPages * 100} comments).`,
  );
}

function dispatchMergeQueue(io: CampaignVerdictsIo): void {
  io.gh([
    'workflow',
    'run',
    MERGE_QUEUE_WORKFLOW,
    '--repo',
    io.repo,
    '--ref',
    'main',
    '-f',
    'dry_run=false',
  ]);
}

function removeQueueLabel(io: CampaignVerdictsIo, prNumber: number): void {
  try {
    io.gh(['api', '-X', 'DELETE', `repos/${io.repo}/issues/${prNumber}/labels/${QUEUE_LABEL}`]);
  } catch (error) {
    if (!LABEL_NOT_FOUND.test(formatErrorMessage(error))) {
      throw error;
    }
  }
}

function formatDecisionSummary(
  prNumber: number,
  decision: CampaignVerdictDecision,
  dryRun: boolean,
): string {
  const specState = decision.latestByAxis.spec ?? 'none';
  const standardsState = decision.latestByAxis.standards ?? 'none';
  if (decision.action === 'add-label') {
    let prefix = `Added ${QUEUE_LABEL}`;
    if (dryRun) prefix = `Dry run: would add ${QUEUE_LABEL}`;
    return `${prefix} to #${prNumber} at ${decision.headSha} (spec=${specState}, standards=${standardsState}).`;
  }
  if (decision.action === 'remove-label') {
    let prefix = `Removed ${QUEUE_LABEL}`;
    if (dryRun) prefix = `Dry run: would remove ${QUEUE_LABEL}`;
    return `${prefix} from #${prNumber} at ${decision.headSha}: ${decision.reason} (spec=${specState}, standards=${standardsState}, stale=${decision.staleVerdictCount}).`;
  }
  return `No label change on #${prNumber} at ${decision.headSha}: ${decision.reason} (spec=${specState}, standards=${standardsState}, stale=${decision.staleVerdictCount}, untrusted=${decision.untrustedVerdictCount}, malformed=${decision.malformedVerdictCount}).`;
}

export function reconcileCampaignVerdicts(
  io: CampaignVerdictsIo,
  prNumber: number,
  options: {
    dryRun?: boolean;
    maxCommentPages?: number;
    triggerHadTrustedVerdict?: boolean;
  } = {},
): CampaignVerdictDecision {
  const dryRun = options.dryRun === true;
  const maxPages = options.maxCommentPages ?? DEFAULT_MAX_COMMENT_PAGES;
  const triggerHadTrustedVerdict = options.triggerHadTrustedVerdict === true;
  const pull = fetchPullState(io, prNumber);

  // An unlabeled or closed PR that already fails structural PR gates needs neither
  // add-label nor remove-label, so comment pagination can be skipped safely.
  const canSkipComments =
    pull.state !== 'open'
    || (!pull.labels.includes(QUEUE_LABEL)
      && (!isSameRepo(pull.headRepoFullName, io.repo) || pull.baseRef !== 'main' || pull.isDraft));
  if (canSkipComments) {
    const early = evaluateCampaignVerdicts({
      repo: io.repo,
      pull,
      comments: [],
      triggerHadTrustedVerdict,
    });
    io.log(formatDecisionSummary(prNumber, early, dryRun));
    return early;
  }

  const comments = fetchPullComments(io, prNumber, maxPages);
  const decision = evaluateCampaignVerdicts({
    repo: io.repo,
    pull,
    comments,
    triggerHadTrustedVerdict,
  });

  if (!dryRun) {
    if (decision.action === 'add-label') {
      io.gh([
        'api',
        '-X',
        'POST',
        `repos/${io.repo}/issues/${prNumber}/labels`,
        '-f',
        `labels[]=${QUEUE_LABEL}`,
      ]);
      dispatchMergeQueue(io);
    } else if (decision.action === 'remove-label') {
      removeQueueLabel(io, prNumber);
      dispatchMergeQueue(io);
    }
  }

  io.log(formatDecisionSummary(prNumber, decision, dryRun));
  return decision;
}

function readTriggerVerdictFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const eventName = env.GITHUB_EVENT_NAME;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventName !== 'issue_comment' || eventPath === undefined || eventPath.trim() === '') {
    return false;
  }
  try {
    const raw = readFileSync(eventPath, 'utf8');
    return detectTrustedTriggerVerdict(eventName, JSON.parse(raw));
  } catch {
    return false;
  }
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
    const triggerHadTrustedVerdict = readTriggerVerdictFromEnv(process.env);
    reconcileCampaignVerdicts(defaultIo(repo), prNumber, {
      dryRun,
      triggerHadTrustedVerdict,
    });
  } catch (error) {
    console.error(formatErrorMessage(error));
    process.exit(2);
  }
}
