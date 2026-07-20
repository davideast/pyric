#!/usr/bin/env bash
# Publish all lockstep pyric packages at a given version.
#
#   bash scripts/publish-alpha.sh 0.1.0-alpha.9
#   bash scripts/publish-alpha.sh --dry-run 0.1.0-alpha.9
#
# Steps: gates (`bun run test` + `bun run test:packaging` — publishing is
# irreversible, so the tree proves itself first; skip with
# PYRIC_PUBLISH_SKIP_GATES=1 only when they just ran on this exact tree)
# → pack (full rebuild) → publish each tarball under the `alpha`
# dist-tag → point `latest` at the same version → run `compat:check`
# against the pinned Firebase version and move the `fb<major>.<minor>`
# compatibility certificate tag if it is green → print the dist-tags for
# eyeball verification. Package versions must already be bumped (lockstep)
# and merged; this script only ships what the tree builds.
#
# Notes:
#  - Tarball names are npm's flattened form (`@pyric/ui` → `pyric-ui-…`),
#    which is why the two lists below differ.
#  - `--access public` is required for the scoped package's publishes and a
#    no-op for the rest.
#  - Publishing an existing package with `--tag alpha` moves ONLY the alpha
#    tag; the explicit dist-tag step is what moves `latest`. (A brand-new
#    package gets `latest` implicitly on first publish — the registry
#    requires one — but relying on that is what the explicit step avoids.)
#  - The `fb` tag is a certificate, not an opinion: it moves only when
#    `compat:check` is green against the pinned Firebase version, and it
#    is the only thing that issues it. A red gate withholds the tag and
#    fails the script — no release ships silently without a compatibility
#    claim. See
#    packages/site-docs/src/content/trust/versioning-and-compatibility.md.
#  - `create-pyric` ships on alpha/latest with the others but does not
#    receive an `fb*` tag (it is a scaffolder, not a Firebase mirror).
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

V="${1:?usage: bash scripts/publish-alpha.sh [--dry-run] <version> (e.g. 0.1.0-alpha.9)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The argument controls publish filenames and dist-tags, while npm pack names
# tarballs from each package.json. Refuse a mismatch before doing the expensive
# build or touching the registry.
node "$ROOT/scripts/lib/check-publish-version.mjs" "$V" "$ROOT"

cd "$ROOT"

# ─── pre-publish gates ─────────────────────────────────────────────────
# Publishing is irreversible, so the tree must prove itself before the
# first npm publish. compat:check runs again later only to gate the fb
# certificate tag; these two decide whether anything ships at all.
# PYRIC_PUBLISH_SKIP_GATES=1 skips them when they demonstrably just ran
# on this exact tree (e.g. recovering deliberately after an authentication
# failure before the first upload).
if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
  echo "━━━ pre-publish gates: bun run test ━━━"
  bun run test
  echo "━━━ pre-publish gates: bun run test:packaging ━━━"
  bun run test:packaging
fi

bash scripts/pack-packages.sh

# Behavioral smoke against the exact tarballs about to ship: installed-CLI
# can-i-use exit codes and both conformance subpaths (scripts/release-smoke.sh).
bash scripts/release-smoke.sh "$V"

PUBLISH_ARGS=(--tag alpha --access public)
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "━━━ npm authentication (read-only) ━━━"
  npm whoami --registry=https://registry.npmjs.org/

  echo ""
  echo "━━━ npm publish validation (dry-run; no upload) ━━━"
  PUBLISH_ARGS+=(--dry-run)
fi

for t in pyric pyric-admin create-pyric pyric-cli pyric-ui; do
  npm publish "dist/packages/${t}-${V}.tgz" "${PUBLISH_ARGS[@]}"
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "━━━ compat:check (dry-run; no dist-tag mutation) ━━━"
  bun run compat:check
  FB_TAG="$(bun run packages/conformance/src/print-fb-tag.ts)"

  echo ""
  echo "Preflight complete. No packages or dist-tags were published or changed."
  echo "A real release would move alpha and latest to ${V}, and ${FB_TAG} on compatible packages."
  exit 0
fi

for p in pyric pyric-admin create-pyric @pyric/cli @pyric/ui; do
  npm dist-tag add "${p}@${V}" latest
done

# ─── fb<major>.<minor> compatibility certificate ───────────────────────
# Tag only the currently pinned Firebase line (patch discarded), and only
# on a green compat:check. Never move an fb tag backward — the loop below
# only ever moves the CURRENT pin's tag forward to this publish.
echo ""
echo "━━━ compat:check (gates the fb dist-tag) ━━━"
if bun run compat:check; then
  FB_TAG="$(bun run packages/conformance/src/print-fb-tag.ts)"
  echo "compat:check green — moving ${FB_TAG} -> ${V}"
  for p in pyric pyric-admin @pyric/cli @pyric/ui; do
    npm dist-tag add "${p}@${V}" "${FB_TAG}"
  done
else
  echo "compat:check FAILED — ${V} does not carry a compatibility claim; no fb tag moved" >&2
  exit 1
fi

for p in pyric pyric-admin create-pyric @pyric/cli @pyric/ui; do
  echo "== ${p}"; npm dist-tag ls "${p}"
done

echo ""
echo "Published. Pin the commit so hotfixes can branch from it:"
echo "  git tag v${V} && git push origin v${V}"
