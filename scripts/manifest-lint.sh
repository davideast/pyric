#!/usr/bin/env bash
# Static packaging-correctness gate for the publishable libraries.
#
# Three checks the consumer-install gate (packaging-test.sh) structurally can't do,
# because a runtime `import()` never looks at the `types` condition and can't see a
# missing export:
#   1. publint   — package.json publishing correctness (exports condition ORDER,
#                  files coverage, missing-file targets, deprecated fields).
#   2. attw      — @arethetypeswrong/cli: every export resolves to types + JS for a
#                  modern ESM consumer (`node16 from ESM`). Run under the `esm-only`
#                  profile: the package is ESM-only by design, so node10 +
#                  CJS-resolution "failures"
#                  are EXPECTED and ignored; a regression in the ESM path still fails.
#   3. check-exports.mjs — exports ↔ dist drift, both directions.
#
# Fast + flake-free (pure static analysis over the built packages — no network, no
# server). Requires the packages to be BUILT first (`bun run build`).
#
# Run: bash scripts/manifest-lint.sh   (or: npm run lint:manifest)
#      bash scripts/manifest-lint.sh --packages dist/packages
#
# With --packages, publint and attw read each package's tarball in that
# directory, the files npm uploads, instead of packing the package directory
# again. The packaging gate runs it that way.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The five publishable packages. @pyric/studio is embedded into @pyric/cli for
# `pyric sandbox --ui`, not published as part of this pack gate.
PACKAGES=(pyric pyric-admin cli ui create-pyric)

PACKAGES_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --packages) PACKAGES_DIR="$(cd "${2:?--packages needs a directory}" && pwd)"; shift 2 ;;
    *) echo "manifest-lint: unknown argument $1 (takes --packages <dir>)" >&2; exit 2 ;;
  esac
done

# What publint and attw read for a package: its tarball under --packages, its directory otherwise.
lint_target() {
  local p="$1" name version
  if [ -z "$PACKAGES_DIR" ]; then
    printf '%s' "packages/$p"
    return
  fi
  name=$(jq -r '.name' "packages/$p/package.json")
  version=$(jq -r '.version' "packages/$p/package.json")
  printf '%s' "$PACKAGES_DIR/$(printf '%s' "${name#@}" | tr '/' '-')-${version}.tgz"
}
ATTW="$ROOT/node_modules/.bin/attw"
PUBLINT="$ROOT/node_modules/.bin/publint"

for tool in "$ATTW" "$PUBLINT"; do
  [ -x "$tool" ] || { echo "✗ $tool not found — run 'bun install'" >&2; exit 1; }
done
for p in "${PACKAGES[@]}"; do
  [ -d "packages/$p/dist" ] || { echo "✗ packages/$p/dist missing — run 'bun run build' first" >&2; exit 1; }
done

fail=0
LOG="$(mktemp -d)"
trap 'rm -rf "$LOG"' EXIT

# Quiet on success, full detail on failure — a green gate shouldn't bury the log.
echo "━━━ publint (publishing correctness) ━━━"
for p in "${PACKAGES[@]}"; do
  if "$PUBLINT" run "$(lint_target "$p")" > "$LOG/publint-$p.txt" 2>&1; then
    echo "  ✓ $p"
  else
    echo "  ✗ $p"; cat "$LOG/publint-$p.txt"; fail=1
  fi
done

echo ""
echo "━━━ attw (types resolve for ESM consumers; esm-only profile) ━━━"
for p in "${PACKAGES[@]}"; do
  attw_args=(--pack "packages/$p")
  if [ -n "$PACKAGES_DIR" ]; then attw_args=("$(lint_target "$p")"); fi
  if "$ATTW" "${attw_args[@]}" --profile esm-only > "$LOG/attw-$p.txt" 2>&1; then
    echo "  ✓ $p"
  else
    echo "  ✗ $p — types resolution problems:"; cat "$LOG/attw-$p.txt"; fail=1
  fi
done

echo ""
echo "━━━ exports ↔ dist drift ━━━"
node "$ROOT/scripts/lib/check-exports.mjs" --all || fail=1

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✗ manifest-lint FAILED — see above" >&2
  exit 1
fi
echo "✓ manifest-lint PASS — publint + attw + exports drift clean for all ${#PACKAGES[@]} packages"
