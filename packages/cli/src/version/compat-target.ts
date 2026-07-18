/**
 * Single source of truth for the Firebase version pyric is conformance-
 * tested against — the number `pyric --version` prints alongside
 * @pyric/cli' own version, and the number `scripts/publish-alpha.sh`
 * reads to derive the `fb<major>.<minor>` dist-tag it moves on a green
 * `compat:check` (see
 * packages/site-docs/src/content/trust/versioning-and-compatibility.md).
 *
 * This is a pin, not @pyric/cli' own version: bumping it starts a
 * re-snapshot of the upstream surface, and no release claims the new
 * `fb` line until `compat:check` passes against it.
 *
 * TODO: once the upstream-surface snapshot lands, that snapshot becomes
 * the source of truth for this value and this constant should read
 * from it instead of being hand-set.
 */
export const FIREBASE_TESTED_AGAINST = '12.13.0';
