#!/usr/bin/env bash
# The conformance gate chain from the build-and-test job, extracted so CI can
# run it concurrently with the CLI test suite (scripts/ci/run-concurrently.ts).
# Order matches the original serial steps; each gate is read-only against the
# built workspace. GITHUB_STEP_SUMMARY is absent locally, so the coverage
# report tees to /dev/null there.
#
# The coverage gate compares this commit's report with its base commit's.
# CI restores the base report from the Actions cache into
# COVERAGE_BASE_REPORT. On a miss, this script computes it from a worktree of
# the base commit (its own install, build and report) while the gates before
# the coverage gate run.
set -euo pipefail

scratch="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
base_sha="${COVERAGE_BASE_SHA:-$(git merge-base HEAD origin/main)}"
base_report="${COVERAGE_BASE_REPORT:-$scratch/coverage-report/report.json}"
head_report="${COVERAGE_HEAD_REPORT:-$scratch/coverage-head-report.json}"
base_log="$scratch/coverage-base-report.log"

compute_base_report() {
  local worktree="$scratch/coverage-base-$base_sha"
  mkdir -p "$(dirname "$base_report")"
  git worktree add --detach --force "$worktree" "$base_sha"
  (
    cd "$worktree"
    bun install --frozen-lockfile --filter '!@pyric/playground'
    bash scripts/build.sh --packages-only
    # An empty census path makes the base build its own census instead of
    # reading the head's job-local cache.
    PYRIC_SURFACE_CENSUS_PATH='' bun run packages/conformance/src/coverage.ts --json > "$base_report.partial"
  )
  mv "$base_report.partial" "$base_report"
  echo "Base coverage report computed in ${SECONDS}s."
}

base_pid=''
if [ -s "$base_report" ]; then
  echo "Coverage base report for $base_sha restored from the cache."
else
  echo "No cached coverage report for $base_sha; computing it from a worktree of that commit."
  compute_base_report > "$base_log" 2>&1 &
  base_pid=$!
fi

# Oracle audit gate (no NEW uncited ✓ COMPAT rows)
bun run packages/conformance/src/audit-gate.ts
# Oracle conformance gate (observations × probes)
bun run packages/conformance/src/check-observations.ts
# Conformance graph integrity
bun run --cwd packages/conformance typecheck
bun run compat:validate
bun run compat:census-gate
# Entry-path conformance gate (cliff, not a ratchet)
bun run compat:entry-path
# Runtime conformance verdict projection
bun run compat:conformance:check
gates_done="$SECONDS"

if [ -n "$base_pid" ]; then
  if ! wait "$base_pid"; then
    cat "$base_log"
    echo "Could not compute the coverage report for the base commit $base_sha (log above)." >&2
    exit 1
  fi
  tail -n 1 "$base_log"
  echo "Computed the coverage report for $base_sha; the other gates finished at ${gates_done}s."
fi

# Compat coverage gate (surface + behavior %, regression-only, vs. the base commit)
bun run compat:coverage --base-report "$base_report" --base-commit "$base_sha" --report-out "$head_report" \
  | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
