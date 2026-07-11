#!/usr/bin/env bash
# Publish all four pyric packages at a given version.
#
#   bash scripts/publish-alpha.sh 0.1.0-alpha.9
#
# Steps: pack (full rebuild) → publish each tarball under the `alpha`
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
#    packages/pyric/docs/explanation/versioning-and-compatibility.md.
set -euo pipefail

V="${1:?usage: bash scripts/publish-alpha.sh <version> (e.g. 0.1.0-alpha.9)}"

bash scripts/pack-packages.sh

for t in pyric pyric-admin pyric-tools pyric-ui; do
  npm publish "dist/packages/${t}-${V}.tgz" --tag alpha --access public
done

for p in pyric pyric-admin pyric-tools @pyric/ui; do
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
  for p in pyric pyric-admin pyric-tools @pyric/ui; do
    npm dist-tag add "${p}@${V}" "${FB_TAG}"
  done
else
  echo "compat:check FAILED — ${V} does not carry a compatibility claim; no fb tag moved" >&2
  exit 1
fi

for p in pyric pyric-admin pyric-tools @pyric/ui; do
  echo "== ${p}"; npm dist-tag ls "${p}"
done
