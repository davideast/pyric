// Open-or-update helpers for the scheduled CI lanes that file one issue and
// keep it current. `sdk-drift.ts` files one per package and major;
// `oracle-leg-report.ts` files one for the weekly oracle re-capture. Both go
// through `gh`, which the workflow authenticates with GH_TOKEN.
//
// `gh issue *` commands use GitHub's GraphQL API, which occasionally fails with
// opaque server errors (`GraphQL: Something went wrong while executing your
// query`) or 5xx responses. Each helper tries `gh issue *` first and falls back
// to GitHub's REST API via `gh api` when a GraphQL or transient 5xx error occurs.

import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Runs `gh` with `args` and returns its stdout. Throws when `gh` fails. */
export type Gh = (args: string[]) => string;

export interface IssueFiling {
  /** Every title this issue has had starts with this prefix. */
  prefix: string;
  title: string;
  label: string;
  /** A Markdown file: the body of a new issue, or the comment on an open one. */
  bodyFile: string;
  /** Optional `owner/repo` override for REST fallback; defaults to GITHUB_REPOSITORY or `{owner}/{repo}`. */
  repository?: string;
}

const TRANSIENT_GH_PATTERNS: readonly RegExp[] = [
  /GraphQL:/i,
  /Something went wrong while executing your query/i,
  /HTTP 50[0234]\b/i,
  /\b50[0234]\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i,
];

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Whether a `gh` failure indicates a GitHub GraphQL or transient 5xx/network error. */
export function isGraphQlOrTransientGhError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return TRANSIENT_GH_PATTERNS.some((pattern) => pattern.test(message));
}

function resolveRestIssuesBase(repository?: string): string {
  const explicitRepo = (repository ?? '').trim();
  if (explicitRepo !== '' && /^[^/\s]+\/[^/\s]+$/.test(explicitRepo)) {
    return `repos/${explicitRepo}/issues`;
  }
  const envRepo = (process.env.GITHUB_REPOSITORY ?? '').trim();
  if (envRepo !== '' && /^[^/\s]+\/[^/\s]+$/.test(envRepo)) {
    return `repos/${envRepo}/issues`;
  }
  return 'repos/{owner}/{repo}/issues';
}

function withTempPayloadFile<T>(
  anchorFile: string,
  payload: Record<string, unknown>,
  run: (payloadFile: string) => T,
): T {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let payloadFile: string;
  if (anchorFile !== '') {
    payloadFile = join(dirname(anchorFile), `.gh-rest-payload-${unique}.json`);
  } else {
    payloadFile = join(tmpdir(), `gh-rest-payload-${unique}.json`);
  }
  writeFileSync(payloadFile, `${JSON.stringify(payload)}\n`);
  try {
    return run(payloadFile);
  } finally {
    try {
      unlinkSync(payloadFile);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function spawnGh(cwd: string): Gh {
  return (args) => {
    const out = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (out.status !== 0) {
      const detail = (out.stderr || out.stdout || `exit code ${String(out.status)}`).trim();
      throw new Error(`gh ${args[0]} ${args[1]} failed: ${detail}`);
    }
    return out.stdout;
  };
}

interface RestIssueRecord {
  number: number;
  title: string;
  pull_request?: unknown;
}

function flattenRestIssuePages(parsed: unknown): RestIssueRecord[] {
  if (!Array.isArray(parsed)) {
    return [];
  }
  const issues: RestIssueRecord[] = [];
  for (const entry of parsed) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        issues.push(item as RestIssueRecord);
      }
    } else if (entry !== null && typeof entry === 'object') {
      issues.push(entry as RestIssueRecord);
    }
  }
  return issues;
}

/** The number of the open issue whose title starts with `prefix`. */
export function findOpenIssue(gh: Gh, prefix: string, repository?: string): number | undefined {
  try {
    const issues = JSON.parse(
      gh([
        'issue',
        'list',
        '--state',
        'open',
        '--limit',
        '50',
        '--json',
        'number,title',
        '--search',
        `"${prefix}" in:title`,
      ]),
    ) as { number: number; title: string }[];
    return issues.find((issue) => issue.title.startsWith(prefix))?.number;
  } catch (error) {
    if (!isGraphQlOrTransientGhError(error)) {
      throw error;
    }
    const base = resolveRestIssuesBase(repository);
    const parsed: unknown = JSON.parse(
      gh(['api', '--paginate', '--slurp', `${base}?state=open&per_page=100`]),
    );
    const restIssues = flattenRestIssuePages(parsed);
    const match = restIssues.find(
      (issue) => issue.pull_request === undefined && issue.title.startsWith(prefix),
    );
    return match?.number;
  }
}

function createIssueWithFallback(gh: Gh, filing: IssueFiling): string {
  try {
    return gh([
      'issue',
      'create',
      '--title',
      filing.title,
      '--label',
      filing.label,
      '--body-file',
      filing.bodyFile,
    ]).trim();
  } catch (error) {
    if (!isGraphQlOrTransientGhError(error)) {
      throw error;
    }
    const body = readFileSync(filing.bodyFile, 'utf8');
    const base = resolveRestIssuesBase(filing.repository);
    const payload: Record<string, unknown> = {
      title: filing.title,
      body,
      labels: [filing.label],
    };
    return withTempPayloadFile(filing.bodyFile, payload, (payloadFile) =>
      gh(['api', '-X', 'POST', base, '--input', payloadFile, '--jq', '.html_url']).trim(),
    );
  }
}

function commentIssueWithFallback(
  gh: Gh,
  issueNumber: number,
  bodyFile: string,
  repository?: string,
): string {
  try {
    return gh(['issue', 'comment', String(issueNumber), '--body-file', bodyFile]).trim();
  } catch (error) {
    if (!isGraphQlOrTransientGhError(error)) {
      throw error;
    }
    const body = readFileSync(bodyFile, 'utf8');
    const base = resolveRestIssuesBase(repository);
    return withTempPayloadFile(bodyFile, { body }, (payloadFile) =>
      gh([
        'api',
        '-X',
        'POST',
        `${base}/${issueNumber}/comments`,
        '--input',
        payloadFile,
        '--jq',
        '.html_url',
      ]).trim(),
    );
  }
}

function retitleIssue(
  gh: Gh,
  number: number,
  title: string,
  anchorFile: string,
  repository?: string,
): void {
  try {
    gh(['issue', 'edit', String(number), '--title', title]);
  } catch (error) {
    if (isGraphQlOrTransientGhError(error)) {
      try {
        const base = resolveRestIssuesBase(repository);
        withTempPayloadFile(anchorFile, { title }, (payloadFile) => {
          gh(['api', '-X', 'PATCH', `${base}/${number}`, '--input', payloadFile, '--jq', '.html_url']);
        });
        return;
      } catch (restError) {
        throw new Error(
          `Commented on #${number}, but retitling it failed: ${errorMessageOf(restError)}`,
        );
      }
    }
    throw new Error(`Commented on #${number}, but retitling it failed: ${errorMessageOf(error)}`);
  }
}

function closeIssueWithFallback(
  gh: Gh,
  issueNumber: number,
  anchorFile: string,
  repository?: string,
): void {
  try {
    gh(['issue', 'close', String(issueNumber)]);
  } catch (error) {
    if (!isGraphQlOrTransientGhError(error)) {
      throw error;
    }
    const base = resolveRestIssuesBase(repository);
    withTempPayloadFile(anchorFile, { state: 'closed' }, (payloadFile) => {
      gh(['api', '-X', 'PATCH', `${base}/${issueNumber}`, '--input', payloadFile, '--jq', '.html_url']);
    });
  }
}

/**
 * Opens the issue, or comments the body file on the open one and then retitles
 * it. The comment goes first, so a failed retitle cannot lose the week's table;
 * the retitle failure then fails the step, naming the issue. Returns what `gh`
 * printed: the new issue's URL or the comment's URL.
 */
export function openOrUpdateIssue(gh: Gh, filing: IssueFiling): string {
  const existing = findOpenIssue(gh, filing.prefix, filing.repository);
  if (existing === undefined) {
    return createIssueWithFallback(gh, filing);
  }
  const commented = commentIssueWithFallback(gh, existing, filing.bodyFile, filing.repository);
  retitleIssue(gh, existing, filing.title, filing.bodyFile, filing.repository);
  return commented;
}

/**
 * Comments the body file on the open issue, then closes it. Returns the number
 * closed, or undefined when no issue was open.
 */
export function closeOpenIssue(
  gh: Gh,
  prefix: string,
  bodyFile: string,
  repository?: string,
): number | undefined {
  const existing = findOpenIssue(gh, prefix, repository);
  if (existing === undefined) {
    return undefined;
  }
  commentIssueWithFallback(gh, existing, bodyFile, repository);
  closeIssueWithFallback(gh, existing, bodyFile, repository);
  return existing;
}
