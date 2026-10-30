#!/usr/bin/env bun
// Reruns a failed Build & Test run on main once, then files what happened.
// `.github/workflows/main-failure.yml` runs it when a push run on main
// completes, and on a manual dispatch:
//
//   bun scripts/ci/main-failure.ts
//
// Attempt 1 failed: rerun only its failed jobs, wait for attempt 2, and file
// its result. Build & Test on main cancels an in-progress run when another
// starts, and a rerun joins that group, so attempt 1 is rerun only while its
// commit is still the head of main and no newer push run is pending; otherwise
// its failures go to the one `Unconfirmed failures on main: ` issue. Attempt 2
// passed: each test (or job, when its log names no test) that failed in
// attempt 1 is a flake, filed as one `lane:velocity` issue titled
// `Flaky on main: <test>`, or commented on an open issue that already names
// the test file. Attempt 2 failed: open or update the one `Main is red: `
// issue. Attempt 2 cancelled: attempt 1's failures go to the unconfirmed
// issue. Any green run closes the red issue. Nothing is rerun past attempt 1,
// so a run is never rerun twice. Issues go through `github-issues.ts`.
//
// Environment: RUN_ID (required), RUN_ATTEMPT (the attempt that completed;
// a dispatch leaves it empty and every attempt of the run is classified),
// DRY_RUN ('true' prints the plan and changes nothing), GITHUB_REPOSITORY,
// GH_TOKEN.

import { defaultContext, dryRun, getRun, handleAttempt } from '../lib/main-failure/github.ts';

function positive(value: string | undefined): number | undefined {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return undefined;
}

if (import.meta.main) {
  const runId = positive(process.env.RUN_ID);
  const repo = process.env.GITHUB_REPOSITORY;
  if (runId === undefined || !repo) {
    console.error('usage: RUN_ID=<run id> GITHUB_REPOSITORY=<owner/repo> [RUN_ATTEMPT=<n>] [DRY_RUN=true] bun scripts/ci/main-failure.ts');
    process.exit(2);
  }
  const context = defaultContext(repo);
  const attempt = positive(process.env.RUN_ATTEMPT);
  if (process.env.DRY_RUN !== 'false') {
    dryRun(context, runId, attempt);
  } else {
    await handleAttempt(context, runId, attempt ?? getRun(context, runId).run_attempt);
  }
}
