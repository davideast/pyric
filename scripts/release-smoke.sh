#!/usr/bin/env bash
# Behavioral smoke test against the packed release tarballs — the last check
# before publishing. test:packaging proves the tarballs install and resolve;
# this proves the flagship behaviors behave, from the installed artifacts:
#
#   - `pyric can-i-use <exact>` resolves an exact match and exits 0
#   - `pyric can-i-use <shouted>` returns suggestions and exits 1
#   - @pyric/cli/conformance and /conformance/browser both answer queries
#
# Run after `bash scripts/pack-packages.sh` (or inside publish-alpha.sh, which
# packs first): bash scripts/release-smoke.sh <version>
set -uo pipefail

V="${1:?usage: bash scripts/release-smoke.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/pyric-release-smoke"
FAILED=0

for t in "pyric-${V}.tgz" "pyric-admin-${V}.tgz" "create-pyric-${V}.tgz" "pyric-cli-${V}.tgz"; do
  if [ ! -f "$ROOT/dist/packages/$t" ]; then
    echo "release-smoke: missing $ROOT/dist/packages/$t — run scripts/pack-packages.sh first" >&2
    exit 1
  fi
done

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
npm init -y > /dev/null 2>&1
# cli pulls pyric/pyric-admin/create-pyric as real deps; feed npm all four
# tarballs so workspace-derived ranges resolve locally, not from the registry.
npm install --no-audit --no-fund --silent \
  "$ROOT/dist/packages/pyric-${V}.tgz" \
  "$ROOT/dist/packages/pyric-admin-${V}.tgz" \
  "$ROOT/dist/packages/create-pyric-${V}.tgz" \
  "$ROOT/dist/packages/pyric-cli-${V}.tgz" || { echo "✗ npm install of tarballs failed" >&2; exit 1; }

check() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ✓ ${label}"
  else
    echo "  ✗ ${label}" >&2
    FAILED=1
  fi
}

expect_exit() {
  local label="$1" want="$2"; shift 2
  "$@" > /dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then
    echo "  ✓ ${label} (exit ${got})"
  else
    echo "  ✗ ${label} — exit ${got}, expected ${want}" >&2
    FAILED=1
  fi
}

echo "━━━ release smoke: pyric can-i-use (installed CLI) ━━━"
expect_exit "exact identity resolves"        0 npx --no-install pyric can-i-use firestore-rules/getAfter
expect_exit "shouted name is refused"        1 npx --no-install pyric can-i-use GETAFTER
expect_exit "unknown feature is refused"     1 npx --no-install pyric can-i-use not-a-real-feature

echo "━━━ release smoke: conformance subpaths (installed package) ━━━"
check "node entry answers exact query" node -e '
  import("@pyric/cli/conformance").then((m) => {
    const r = m.canIUse("storage/getDownloadURL");
    if (r.match !== "exact" || !r.supports[0].availability) process.exit(1);
  }).catch(() => process.exit(1));'
check "browser entry answers the same query" node -e '
  import("@pyric/cli/conformance/browser").then((m) => {
    const r = m.canIUse("storage/getDownloadURL");
    if (r.match !== "exact" || !r.supports[0].evidenceSlug) process.exit(1);
  }).catch(() => process.exit(1));'
check "import evidence resolves a published import" node -e '
  import("@pyric/cli/conformance").then((m) => {
    if (!m.canIUseImport("pyric/storage")?.evidenceSlug) process.exit(1);
  }).catch(() => process.exit(1));'

if [ "$FAILED" -ne 0 ]; then
  echo "release-smoke: FAILED — work dir kept at $WORK" >&2
  exit 1
fi
rm -rf "$WORK"
echo "release-smoke: all behaviors verified from installed tarballs"
