#!/usr/bin/env bun
// Formats or posts an Advisor campaign review verdict comment for a pull request.
//
// Print only:
//   bun scripts/ci/campaign-verdict.ts --axis spec --verdict MERGE --sha <40-hex> --summary "All checks passed."
//
// Post to a pull request via `gh api` (requires OWNER, MEMBER, or COLLABORATOR user token):
//   bun scripts/ci/campaign-verdict.ts --pr 123 --repo davideast/pyric --axis spec --verdict MERGE --sha <40-hex> --summary-file review.md

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidAxis,
  assertValidVerdict,
  formatVerdictComment,
  normalizeCommitSha,
  type CampaignAxis,
  type CampaignVerdict,
} from './campaign-verdict-markers.ts';

export interface ParsedVerdictCliArgs {
  axis: CampaignAxis;
  verdict: CampaignVerdict;
  sha: string;
  summary?: string;
  summaryFile?: string;
  pr?: number;
  repo?: string;
  dryRun: boolean;
}

export interface VerdictCliIo {
  gh: (args: string[]) => string;
  readText: (path: string) => string;
  withBodyFile: <T>(body: string, fn: (bodyFile: string) => T) => T;
  log: (text: string) => void;
}

export interface VerdictCliResult {
  comment: string;
  posted: boolean;
  commentUrl?: string;
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parsePositiveInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive integer, received "${raw ?? ''}".`);
  }
  return parsed;
}

function validateRepoName(raw: string): string {
  const trimmed = raw.trim();
  if (!REPO_NAME.test(trimmed)) {
    throw new Error(`Expected repository in "owner/name" format, received "${raw}".`);
  }
  return trimmed;
}

export function resolveDefaultRepo(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env.GH_REPO !== undefined && env.GH_REPO.trim() !== '') {
    return validateRepoName(env.GH_REPO);
  }
  if (env.GITHUB_REPOSITORY !== undefined && env.GITHUB_REPOSITORY.trim() !== '') {
    return validateRepoName(env.GITHUB_REPOSITORY);
  }
  return undefined;
}

export function resolveTempRoot(env: Readonly<Record<string, string | undefined>>): string {
  const runnerTemp = env.RUNNER_TEMP;
  if (runnerTemp !== undefined && runnerTemp.trim() !== '') {
    return runnerTemp.trim();
  }
  return tmpdir();
}

function splitFlagName(token: string): string {
  const equalOffset = token.indexOf('=');
  if (equalOffset === -1) return token;
  return token.slice(0, equalOffset);
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function runGhCommand(args: readonly string[]): string {
  const out = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (out.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${out.stderr || out.error?.message}`);
  }
  return out.stdout;
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const equalOffset = flag.indexOf('=');
  if (equalOffset !== -1) {
    return { value: flag.slice(equalOffset + 1), nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseVerdictCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ParsedVerdictCliArgs {
  let rawAxis: string | undefined;
  let rawVerdict: string | undefined;
  let rawSha: string | undefined;
  let summary: string | undefined;
  let summaryFile: string | undefined;
  let pr: number | undefined;
  let repo: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    const flagName = splitFlagName(token);
    if (
      flagName !== '--axis'
      && flagName !== '--verdict'
      && flagName !== '--sha'
      && flagName !== '--summary'
      && flagName !== '--summary-file'
      && flagName !== '--pr'
      && flagName !== '--repo'
    ) {
      throw new Error(`Unknown argument "${token}".`);
    }
    const read = readFlagValue(argv, index, token);
    index = read.nextIndex;
    if (flagName === '--axis') rawAxis = read.value;
    else if (flagName === '--verdict') rawVerdict = read.value;
    else if (flagName === '--sha') rawSha = read.value;
    else if (flagName === '--summary') summary = read.value;
    else if (flagName === '--summary-file') summaryFile = read.value;
    else if (flagName === '--pr') pr = parsePositiveInteger(read.value, '--pr');
    else if (flagName === '--repo') repo = validateRepoName(read.value);
  }

  if (rawAxis === undefined) throw new Error('Missing required --axis <spec|standards>.');
  if (rawVerdict === undefined) throw new Error('Missing required --verdict <MERGE|FIX>.');
  if (rawSha === undefined) throw new Error('Missing required --sha <40-char-sha>.');
  assertValidAxis(rawAxis);
  assertValidVerdict(rawVerdict);
  const sha = normalizeCommitSha(rawSha);

  if (summary === undefined && summaryFile === undefined) {
    throw new Error('Pass either --summary or --summary-file.');
  }
  if (summary !== undefined && summaryFile !== undefined) {
    throw new Error('Pass either --summary or --summary-file, not both.');
  }

  const resolvedRepo = repo ?? resolveDefaultRepo(env);
  const parsed: ParsedVerdictCliArgs = {
    axis: rawAxis,
    verdict: rawVerdict,
    sha,
    dryRun,
  };
  if (summary !== undefined) parsed.summary = summary;
  if (summaryFile !== undefined) parsed.summaryFile = summaryFile;
  if (pr !== undefined) parsed.pr = pr;
  if (resolvedRepo !== undefined) parsed.repo = resolvedRepo;
  return parsed;
}

export function runVerdictCli(args: ParsedVerdictCliArgs, io: VerdictCliIo): VerdictCliResult {
  let summaryText = args.summary;
  if (summaryText === undefined) {
    if (args.summaryFile === undefined) {
      throw new Error('Pass either --summary or --summary-file.');
    }
    summaryText = io.readText(args.summaryFile);
  }
  const comment = formatVerdictComment({
    axis: args.axis,
    verdict: args.verdict,
    sha: args.sha,
    summary: summaryText,
  });

  if (args.pr === undefined || args.dryRun) {
    io.log(comment);
    return { comment, posted: false };
  }

  let repoSegment = '{owner}/{repo}';
  if (args.repo !== undefined) {
    repoSegment = args.repo;
  }
  const endpoint = `repos/${repoSegment}/issues/${args.pr}/comments`;
  const rawResponse = io.withBodyFile(comment, (bodyFile) =>
    io.gh(['api', '-X', 'POST', endpoint, '-F', `body=@${bodyFile}`]),
  );
  const parsed = JSON.parse(rawResponse) as { html_url?: string };
  const result: VerdictCliResult = { comment, posted: true };
  if (parsed.html_url !== undefined && parsed.html_url !== '') {
    result.commentUrl = parsed.html_url;
    io.log(parsed.html_url);
  } else {
    io.log(`Posted ${args.axis}=${args.verdict} verdict on PR #${args.pr}.`);
  }
  return result;
}

function defaultIo(): VerdictCliIo {
  return {
    gh: (args) => runGhCommand(args),
    readText: (path) => readFileSync(path, 'utf8'),
    withBodyFile: (body, fn) => {
      const tempRoot = resolveTempRoot(process.env);
      const prefix = join(tempRoot, 'campaign-verdict-');
      const dir = mkdtempSync(prefix);
      try {
        const bodyFile = join(dir, 'verdict-comment.md');
        writeFileSync(bodyFile, body, 'utf8');
        return fn(bodyFile);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    log: (text) => console.log(text),
  };
}

if (import.meta.main) {
  try {
    const args = parseVerdictCliArgs(process.argv.slice(2), process.env);
    runVerdictCli(args, defaultIo());
  } catch (error) {
    console.error(formatErrorMessage(error));
    process.exit(2);
  }
}
