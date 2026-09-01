#!/usr/bin/env bash
# Engine↔evidence coupling gate. Security-rules and sandbox enforcement are
# only as trustworthy as the conformance evidence that cites them, so a branch
# that moves ENGINE behavior without moving EVIDENCE is a silent claim that
# nothing observable changed. This gate makes that claim explicit: either the
# branch touches packages/conformance/, or a commit in it carries a
# `Conformance-Exempt: <reason>` trailer. Read-only against the workspace;
# GITHUB_STEP_SUMMARY is absent locally, so notices tee to /dev/null there
# (same convention as scripts/ci/conformance-gates.sh).
set -euo pipefail

# Overridable so CI can point at the PR base (github.base_ref) and the
# self-test can point at a synthetic branch.
BASE_REF="${BASE_REF:-origin/main}"

# Directory prefixes (trailing slash) and exact files that constitute the
# engine. Docs/test-only edits under these paths still count — the trailer is
# the escape hatch, not a heuristic.
ENGINE_PATHS=(
  'packages/pyric/src/rules/'
  'packages/pyric/src/firestore/sandbox/'
  'packages/pyric/src/database/sandbox/'
  'packages/pyric/src/database/sandbox-controls.ts'
  'packages/pyric/src/storage/sandbox/'
  'packages/pyric/src/storage/enforce.ts'
  'packages/pyric/src/sandbox/'
)
EVIDENCE_PATH='packages/conformance/'

say() {
  printf '%s\n' "$1" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# ENGINE_PATHS is a hardcoded list, so a rename upstream would silently retire
# the gate: nothing would ever match again and every engine change would sail
# through. Fail loudly on drift instead. Paths are repo-relative, so anchor them
# at the worktree top level rather than trusting the caller's cwd.
REPO_TOP="$(git rev-parse --show-toplevel)"
for path in "${ENGINE_PATHS[@]}"; do
  if [ ! -e "${REPO_TOP}/${path%/}" ]; then
    say "❌ CONFORMANCE COUPLING GATE — CONFIGURATION DRIFT"
    say "ENGINE_PATHS entry '${path}' no longer exists — update the gate."
    exit 1
  fi
done

# CI checks out at depth 1 for most jobs; recover just enough history to reach
# a merge base rather than requiring every caller to deepen the checkout.
resolve_base() {
  git merge-base "$BASE_REF" HEAD >/dev/null 2>&1 && return 0
  local branch="${BASE_REF#origin/}"
  git fetch --no-tags --quiet origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" 2>/dev/null || true
  git merge-base "$BASE_REF" HEAD >/dev/null 2>&1 && return 0
  git fetch --no-tags --quiet --unshallow origin 2>/dev/null ||
    git fetch --no-tags --quiet --deepen=200 origin 2>/dev/null || true
  git merge-base "$BASE_REF" HEAD >/dev/null 2>&1
}

if ! resolve_base; then
  # In CI an unreachable base means the checkout is wrong (fetch-depth) or the
  # base ref is gone — never that the branch is clean. Passing there would make
  # the gate advisory exactly when it is load-bearing, so fail closed. Locally,
  # a detached or history-less checkout is routine: warn and stay out of the way.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    say "❌ CONFORMANCE COUPLING GATE — UNRESOLVABLE BASE"
    say "No merge base with '${BASE_REF}' is reachable, so this gate cannot verify anything."
    say "Remedy: check out with 'fetch-depth: 0' and pass the PR base as BASE_REF."
    exit 1
  fi
  echo "conformance-coupling-gate: no merge base with '${BASE_REF}' is reachable; nothing to compare." >&2
  exit 0
fi

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD)"

engine_changed=()
evidence_changed=0
# core.quotePath=false plus NUL-delimited output: a default `diff --name-only`
# C-quotes any non-ASCII path ("packages/pyric/src/rules/\303\251valuate.ts"),
# which matches no case arm and would let a renamed-to-Unicode engine file slip
# past the gate entirely.
while IFS= read -r -d '' file; do
  [ -n "$file" ] || continue
  case "$file" in
    "$EVIDENCE_PATH"*)
      evidence_changed=$((evidence_changed + 1))
      continue
      ;;
  esac
  for path in "${ENGINE_PATHS[@]}"; do
    case "$path" in
      */)
        case "$file" in "$path"*) engine_changed+=("$file"); break ;; esac
        ;;
      *)
        if [ "$file" = "$path" ]; then
          engine_changed+=("$file")
          break
        fi
        ;;
    esac
  done
done < <(git -c core.quotePath=false diff --name-only -z "${MERGE_BASE}...HEAD")

# No engine movement, or evidence moved with it: nothing to say.
if [ "${#engine_changed[@]}" -eq 0 ] || [ "$evidence_changed" -gt 0 ]; then
  exit 0
fi

# A waiver must be a real git TRAILER, not any line that happens to start with
# the token: grepping the raw body lets prose ("Conformance-Exempt: ..." pasted
# mid-paragraph, a quoted review note, a revert of an exempt commit) waive the
# gate. `git interpret-trailers --parse` applies git's own trailer-block rules,
# so only the structured last-paragraph form counts. One commit at a time —
# concatenated bodies would let one commit's prose join another's trailer block.
EXEMPTION=''
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  trailer="$(git show -s --format='%B' "$sha" | git interpret-trailers --parse |
    grep -E '^Conformance-Exempt:[[:space:]]*[^[:space:]]' | head -n 1 || true)"
  if [ -n "$trailer" ]; then
    EXEMPTION="$trailer"
    break
  fi
done < <(git rev-list "${MERGE_BASE}..HEAD")

if [ -n "$EXEMPTION" ]; then
  say "⚠️ CONFORMANCE COUPLING GATE — EXEMPT"
  say "Engine files changed with no conformance evidence, waived by an explicit trailer:"
  say "  ${EXEMPTION}"
  for file in "${engine_changed[@]}"; do
    say "  - ${file}"
  done
  exit 0
fi

say "❌ CONFORMANCE COUPLING GATE — FAILED"
say "These engine files changed, but nothing under ${EVIDENCE_PATH} did:"
for file in "${engine_changed[@]}"; do
  say "  - ${file}"
done
say "Remedy: run compat:conformance / compat:rules-score and commit the regenerated evidence, or add a 'Conformance-Exempt: <reason>' trailer to a commit in this branch."
exit 1
