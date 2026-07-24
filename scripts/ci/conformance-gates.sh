#!/usr/bin/env bash
# The conformance gate chain from the build-and-test job, extracted so CI can
# run it concurrently with the CLI test suite (scripts/ci/run-concurrently.ts).
# Order matches the original serial steps; each gate is read-only against the
# built workspace. GITHUB_STEP_SUMMARY is absent locally, so the coverage
# report tees to /dev/null there.
set -euo pipefail

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
# Compat coverage gate (surface + behavior %, regression-only)
bun run compat:coverage | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
