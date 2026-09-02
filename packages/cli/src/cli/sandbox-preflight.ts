/**
 * The pre-flight artifact scan at child launch: which directories are worth
 * looking in, and how a finding is reported.
 *
 * The loader swap only reaches code that still imports firebase or
 * firebase-admin. A backend bundle that compiled the SDK in has no such import
 * left, so it sails past register untouched and talks to live Google.
 */
import { GOOGLE_ENDPOINT_HOSTS } from '../google-endpoints.js';
import { scanInlinedFirebaseHits, type InlinedFirebaseHit } from './inlined-sdk-scanner.js';

/**
 * The backend build outputs a launched child plausibly loads, relative to the
 * project root. `dist` and `build` are the generic bundler outputs, `functions`
 * the Cloud Functions source/output dir, and `.next/server` the Next.js server
 * bundle, the one that lives behind a dot-directory the default frontend scan
 * deliberately skips, and the one most likely to carry an inlined
 * firebase-admin. Missing dirs are skipped by the scanner, so an unbuilt
 * project costs a handful of `existsSync` calls.
 */
export const BACKEND_ARTIFACT_DIRS: readonly string[] = [
  'dist',
  'build',
  '.next/server',
  'functions',
];

/** How many per-file findings print before the rest collapse into a count. */
const PREFLIGHT_MAX_FILE_LINES = 10;

/**
 * Scan the backend build dirs under `root` for any catalog host.
 *
 * The full catalog rather than the SDK fingerprint subset: this check only
 * warns, so a bare callable URL or a public asset URL in a server bundle is
 * worth a line even though it would be wrong to fail a build over.
 */
export function scanBackendArtifacts(root: string): InlinedFirebaseHit[] {
  return scanInlinedFirebaseHits(root, {
    hosts: GOOGLE_ENDPOINT_HOSTS,
    dirs: BACKEND_ARTIFACT_DIRS,
  });
}

/**
 * Render the pre-flight findings, in the interlock's line style.
 *
 * Warn-only: a hit is evidence, not proof. The scanner greps for a host
 * literal, and a stale `dist/` from last month or a vendored copy of someone
 * else's bundle is a false positive that must never stop a launch. So this
 * returns lines to print and nothing else: no throw, no refusal, no exit-code
 * change. The served-frontend check in `serve.ts` still throws; that one gates
 * what pyric itself is about to serve, which is a claim pyric makes rather
 * than a guess about the user's child process.
 *
 * One line per file naming the catalog service and host, then one line saying
 * what a finding means and that nothing was blocked. No hits means no output.
 */
export function formatInlinedArtifactWarnings(hits: readonly InlinedFirebaseHit[]): string[] {
  if (hits.length === 0) return [];
  const lines = hits
    .slice(0, PREFLIGHT_MAX_FILE_LINES)
    .map((hit) => `  ⚠ preflight: ${hit.file} inlines ${hit.service} (${hit.host})`);
  const remaining = hits.length - lines.length;
  if (remaining > 0) lines.push(`  ⚠ preflight: and ${remaining} more file(s)`);
  const noun = hits.length === 1 ? 'build artifact contains' : 'build artifacts contain';
  lines.push(
    `  ⚠ preflight: ${hits.length} ${noun} inlined production Firebase SDK code, which bypasses ` +
      `pyric's module swap. The SDK is compiled INTO the artifact, so there is no ` +
      `firebase/firebase-admin import left for the loader to rewrite and those calls would reach ` +
      `LIVE Firebase. Rebuild with firebase and firebase-admin marked external. Warning only: ` +
      `nothing was blocked.`,
  );
  return lines;
}
