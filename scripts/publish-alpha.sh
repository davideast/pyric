#!/usr/bin/env bash
# Publish all four pyric packages at a given version.
#
#   bash scripts/publish-alpha.sh 0.1.0-alpha.9
#
# Steps: pack (full rebuild) → publish each tarball under the `alpha`
# dist-tag → point `latest` at the same version → print the dist-tags for
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
set -euo pipefail

V="${1:?usage: bash scripts/publish-alpha.sh <version> (e.g. 0.1.0-alpha.9)}"

bash scripts/pack-packages.sh

for t in pyric pyric-admin pyric-tools pyric-ui; do
  npm publish "dist/packages/${t}-${V}.tgz" --tag alpha --access public
done

for p in pyric pyric-admin pyric-tools @pyric/ui; do
  npm dist-tag add "${p}@${V}" latest
done

for p in pyric pyric-admin pyric-tools @pyric/ui; do
  echo "== ${p}"; npm dist-tag ls "${p}"
done
