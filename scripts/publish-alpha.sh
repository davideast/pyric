#!/usr/bin/env bash
# Publish all lockstep pyric packages (default) or `@pyric/rules` alone
# (`--package rules`) at a given version.
#
#   bash scripts/publish-alpha.sh 0.1.0-alpha.36
#   bash scripts/publish-alpha.sh --dry-run 0.1.0-alpha.36
#   bash scripts/publish-alpha.sh --package rules 0.1.0
#   bash scripts/publish-alpha.sh --package rules --dry-run 0.1.0
#
# Publishing is irreversible, so every gate passes before the first upload,
# and the bytes uploaded are the bytes the gates tested. pack-packages.sh
# records each tarball's sha256 and the tree it packed in manifest.json. Once
# every gate passes, the script stamps dist/packages/proven.json, and only if
# the tarballs are still the pack's bytes on the pack's tree
# (scripts/lib/proven-stamp.mjs). The upload copies the proven tarballs into a
# directory of its own, verifies the copies against the stamp, and publishes
# the copies.
#
# A rerun with PYRIC_PUBLISH_SKIP_GATES=1 (after an authentication failure,
# say) skips the gates and the pack. It uploads only when the stamp matches
# HEAD, a clean tree and the exact uploaded tarball set on disk, and refuses
# tarballs from an earlier commit, a pack whose own checks failed, a failed
# build's leftovers, and the leftovers of a run whose gates failed: every
# other run removes the stamp before it starts.
#
# Channels: PYRIC_PUBLISH_TAG picks the dist-tag (default `latest`).
#  - For `pyric` (six lockstep packages):
#    - latest: moves latest and alpha, and the fb certificate when compat:check is green.
#    - next: moves only next, plus the fb certificate when green.
#    - any other tag (for example `exp`): moves only that tag; no fb certificate.
#  - For `--package rules` (`@pyric/rules` on its independent version line,
#    tagged `rules-v<version>`):
#    - publishes `@pyric/rules` under PYRIC_PUBLISH_TAG (note: npm also assigns
#      `latest` automatically on a brand-new package's very first upload);
#      carries no `fb*` tag.
set -euo pipefail

# Pin npm commands (publish, dist-tag, child consumer smokes) to public npmjs.org
# even on machines whose .npmrc defaults to a corporate mirror or proxy.
export NPM_CONFIG_REGISTRY="${PYRIC_NPM_REGISTRY:-https://registry.npmjs.org/}"

DRY_RUN=0
PACKAGE_TARGET="pyric"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --package)
      PACKAGE_TARGET="${2:?--package needs pyric or rules}"
      shift 2
      ;;
    --package=*)
      PACKAGE_TARGET="${1#--package=}"
      shift
      ;;
    -*)
      echo "publish-alpha: unknown flag $1 (expected [--dry-run] [--package pyric|rules] <version>)" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

case "$PACKAGE_TARGET" in
  pyric) ;;
  rules|@pyric/rules) PACKAGE_TARGET="rules" ;;
  *)
    echo "publish-alpha: unknown --package '$PACKAGE_TARGET' (expected pyric or rules)" >&2
    exit 2
    ;;
esac

V="${1:?usage: bash scripts/publish-alpha.sh [--dry-run] [--package pyric|rules] <version>}"
shift
if [ "$#" -ne 0 ]; then
  echo "publish-alpha: unexpected argument(s) after version '$V': $* (flags must precede <version>)" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The argument controls publish filenames and dist-tags, while npm pack names
# tarballs from each package.json. Refuse a mismatch (or drifted @pyric/rules
# content on a pyric release) before doing the expensive build or touching npm.
if [ "$PACKAGE_TARGET" = "rules" ]; then
  node "$ROOT/scripts/lib/check-publish-version.mjs" --package rules "$V" "$ROOT"
else
  node "$ROOT/scripts/lib/check-publish-version.mjs" "$V" "$ROOT"
fi

cd "$ROOT"

# Default lockstep tarballs and package names, overridden for `--package rules`.
TARBALLS=(pyric pyric-admin create-pyric pyric-cli pyric-ui pyric-live)
PACKAGES=(pyric pyric-admin create-pyric @pyric/cli @pyric/ui @pyric/live)
if [ "$PACKAGE_TARGET" = "rules" ]; then
  TARBALLS=(pyric-rules)
  PACKAGES=(@pyric/rules)
fi

# Uploads run in order and cannot be taken back, so a token that can publish
# five of the six would leave a partial release (#2029). Before any gate,
# check with read-only requests that the account can publish every package.
# A package not on the registry yet needs a token that can write across its
# scope, which only the owner can state: PYRIC_PUBLISH_SCOPE_WRITE=@pyric.
echo "=== npm publish access (read-only) ==="
node "$ROOT/scripts/lib/check-publish-access.mjs" "${PACKAGES[@]}"

# A run that proves anything starts unproven: if it fails before the stamp,
# no earlier stamp is left for a gate-skipping rerun to trust.
if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
  rm -f "$ROOT/dist/packages/proven.json"
else
  echo "=== gates skipped: checking the tarballs are the ones an earlier run proved ==="
  node "$ROOT/scripts/lib/proven-stamp.mjs" verify "$ROOT/dist/packages" "$V" "$ROOT" "${TARBALLS[@]}"
fi

# --- pre-publish gates -------------------------------------------------
if [ "$PACKAGE_TARGET" = "rules" ]; then
  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: rules proof ==="
    bun scripts/lib/rules-release-gate.ts proof
  fi

  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    bash scripts/pack-packages.sh --package rules
  fi

  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: rules tarball check ==="
    bun scripts/lib/rules-release-gate.ts tarball "$ROOT/dist/packages/pyric-rules-${V}.tgz"
  fi

  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: rules-standalone app scenario on the packed tarball ==="
    bun test/apps/run.ts --packages dist/packages rules-standalone
  fi
else
  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: bun run test ==="
    bun run test
  fi

  # The one pack. Every gate below tests these tarballs, and the publish step
  # uploads them; nothing rebuilds or repacks in between.
  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    bash scripts/pack-packages.sh
    node "$ROOT/scripts/lib/check-publish-version.mjs" --packed "$ROOT/dist/packages" "$V" "$ROOT"
  fi

  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: packaging gate on the packed tarballs ==="
    bash scripts/packaging-test.sh --packages dist/packages
  fi

  # Behavioral smoke against the exact tarballs about to ship.
  bash scripts/release-smoke.sh "$V"

  if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
    echo "=== pre-publish gates: app scenarios on the packed tarballs ==="
    bun test/apps/run.ts --packages dist/packages
  fi
fi

# Every gate passed on these tarballs: stamp them, if they are still the
# bytes the pack wrote on the tree it packed.
if [ "${PYRIC_PUBLISH_SKIP_GATES:-0}" != "1" ]; then
  node "$ROOT/scripts/lib/proven-stamp.mjs" write "$ROOT/dist/packages" "$V" "$ROOT" "${TARBALLS[@]}"
fi

# Upload copies, verified against the stamp, so nothing that writes to
# dist/packages between the check and the last upload can change what ships.
UPLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pyric-publish-XXXXXX")"
trap 'rm -rf "$UPLOAD_DIR"' EXIT
for t in "${TARBALLS[@]}"; do cp "$ROOT/dist/packages/${t}-${V}.tgz" "$UPLOAD_DIR/"; done
cp "$ROOT/dist/packages/proven.json" "$UPLOAD_DIR/"
node "$ROOT/scripts/lib/proven-stamp.mjs" verify "$UPLOAD_DIR" "$V" "$ROOT" "${TARBALLS[@]}"

PUBLISH_TAG="${PYRIC_PUBLISH_TAG:-latest}"
PUBLISH_ARGS=(--tag "$PUBLISH_TAG" --access public)
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "=== npm authentication (read-only) ==="
  npm whoami --registry=https://registry.npmjs.org/

  echo ""
  echo "=== npm publish validation (dry-run; no upload) ==="
  PUBLISH_ARGS+=(--dry-run)
fi

for t in "${TARBALLS[@]}"; do
  npm publish "$UPLOAD_DIR/${t}-${V}.tgz" "${PUBLISH_ARGS[@]}"
done

if [ "$PACKAGE_TARGET" = "rules" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo ""
    echo "Preflight complete. No packages or dist-tags were published or changed."
    echo "A real release would publish @pyric/rules@${V} under ${PUBLISH_TAG} (note: npm also assigns latest on a package's first upload) and tag rules-v${V}."
    exit 0
  fi

  npm dist-tag add "@pyric/rules@${V}" "${PUBLISH_TAG}"
  echo "== @pyric/rules"; npm dist-tag ls "@pyric/rules"
  echo ""
  echo "Published @pyric/rules@${V} under ${PUBLISH_TAG}. Pin the commit so hotfixes can branch from it:"
  echo "  git tag rules-v${V} && git push origin rules-v${V}"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "=== compat:check (dry-run; no dist-tag mutation) ==="
  bun run compat:check
  FB_TAG="$(bun run packages/conformance/src/print-fb-tag.ts)"

  echo ""
  echo "Preflight complete. No packages or dist-tags were published or changed."
  case "${PUBLISH_TAG}" in
    latest) echo "A real release would move alpha and latest to ${V}, and ${FB_TAG} on compatible packages." ;;
    next) echo "A real release would move next to ${V}, and ${FB_TAG} on compatible packages." ;;
    *) echo "A real release would move only ${PUBLISH_TAG} to ${V}; no fb certificate." ;;
  esac
  exit 0
fi

# Only a latest release moves latest and alpha. `next` and any other channel
# (for example `exp`) move only their own tag.
for p in "${PACKAGES[@]}"; do
  npm dist-tag add "${p}@${V}" "${PUBLISH_TAG}"
  if [ "${PUBLISH_TAG}" = "latest" ]; then
    npm dist-tag add "${p}@${V}" alpha
  fi
done

# An experimental channel carries no compatibility certificate.
if [ "${PUBLISH_TAG}" != "latest" ] && [ "${PUBLISH_TAG}" != "next" ]; then
  for p in "${PACKAGES[@]}"; do
    echo "== ${p}"; npm dist-tag ls "${p}"
  done
  echo ""
  echo "Published under ${PUBLISH_TAG} only. Pin the commit so hotfixes can branch from it:"
  echo "  git tag v${V} && git push origin v${V}"
  exit 0
fi

# --- fb<major>.<minor> compatibility certificate -----------------------
echo ""
echo "=== compat:check (gates the fb dist-tag) ==="
if bun run compat:check; then
  FB_TAG="$(bun run packages/conformance/src/print-fb-tag.ts)"
  echo "compat:check green -- moving ${FB_TAG} -> ${V}"
  for p in pyric pyric-admin @pyric/cli @pyric/ui; do
    npm dist-tag add "${p}@${V}" "${FB_TAG}"
  done
else
  echo "compat:check FAILED -- ${V} does not carry a compatibility claim; no fb tag moved" >&2
  exit 1
fi

for p in "${PACKAGES[@]}"; do
  echo "== ${p}"; npm dist-tag ls "${p}"
done

echo ""
echo "Published. Pin the commit so hotfixes can branch from it:"
echo "  git tag v${V} && git push origin v${V}"
