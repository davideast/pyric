#!/usr/bin/env bash
# Build a Pyric checkout and pack the four packages the CLI needs into
# installable tarballs. Node host mode is not on npm yet, so a project that
# tests it installs these instead of `@pyric/cli@latest`.
#
# Usage: pack-local.sh <pyric-checkout> <output-directory>
# Prints one tarball path per line on stdout; progress goes to stderr.
set -euo pipefail

checkout="${1:?Usage: pack-local.sh <pyric-checkout> <output-directory>}"
output="${2:?Usage: pack-local.sh <pyric-checkout> <output-directory>}"

checkout="$(cd "$checkout" && pwd)"
mkdir -p "$output"
output="$(cd "$output" && pwd)"

rewrite="$checkout/scripts/lib/rewrite-workspace-deps.mjs"
if [ ! -f "$rewrite" ]; then
  echo "Not a Pyric checkout: $rewrite is missing." >&2
  exit 1
fi
if [ ! -f "$checkout/packages/cli/src/serve/hosted/runtime.ts" ]; then
  echo "This checkout has no Node host (packages/cli/src/serve/hosted). Check out main or hosted-main-integration." >&2
  exit 1
fi

echo "Building $checkout" >&2
(cd "$checkout" && bun install --frozen-lockfile >&2 && bash scripts/build.sh --packages-only >&2)

# Order does not matter for packing; all four are installed together.
for package in packages/pyric packages/pyric-admin packages/create-pyric packages/cli; do
  name="$(node -p "require('$checkout/$package/package.json').name")"
  echo "Packing $name" >&2
  tarball="$(cd "$checkout/$package" && npm pack --silent --pack-destination "$output")"
  full="$output/$tarball"

  # npm pack keeps `workspace:*` ranges, which no consumer can install.
  scratch="$(mktemp -d)"
  tar -xzf "$full" -C "$scratch"
  if grep -q 'workspace:' "$scratch/package/package.json"; then
    node "$rewrite" "$scratch/package/package.json" "$checkout" >&2
    (cd "$scratch" && tar -czf "$full" package)
  fi
  rm -rf "$scratch"
  if tar -xzOf "$full" package/package.json | grep -q '"workspace:'; then
    echo "$name still declares a workspace: dependency after the rewrite." >&2
    exit 1
  fi
  echo "$full"
done
