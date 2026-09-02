/**
 * Detect a build that inlined the real Firebase SDK into an artifact.
 *
 * For the served frontend (`vite build` output) the served import map remaps
 * only bare `firebase/*` specifiers, so such a build cannot be sandboxed: its
 * calls reach real Google endpoints. The same fingerprint identifies a backend
 * bundle whose SDK was compiled in past the loader's reach.
 *
 * The caller supplies the host set, because the two callers answer different
 * questions with it. The throwing frontend check in `cli/serve.ts` passes
 * `SDK_FINGERPRINT_HOSTS`, the narrow set that only appears when SDK code was
 * inlined, because a hit there fails a build. The warn-only pre-flight scan at
 * child launch passes the full `GOOGLE_ENDPOINT_HOSTS`, because a hit there is
 * a warning the developer can weigh.
 *
 * This module owns the hit type, so `cli/serve.ts` and `cli/sandbox-preflight.ts`
 * both depend downward on it rather than on each other.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { lookupGoogleEndpoint } from '../google-endpoints.js';

/** Depth limit per scanned directory. */
const MAX_DEPTH = 4;

/** Total script files read across all scanned directories. */
const MAX_FILES = 200;

/**
 * Script extensions worth reading. `.cjs` is what a CommonJS backend build
 * emits, and omitting it made every such artifact invisible. Not `.ts`: no
 * build path in scope emits executable TypeScript, and sourcemaps are
 * deliberately out of scope.
 */
const SCRIPT_FILE = /\.(js|mjs|cjs)$/;

export interface InlinedScanOptions {
  /** Hosts to grep for. Required: see the module header for which set. */
  readonly hosts: readonly string[];
  /**
   * Explicit subdirectories of `root` to scan instead of `root` itself. This
   * is how the pre-flight check points the scanner at backend build output
   * (`dist`, `.next/server`, `functions`), which the default frontend scan
   * never reaches because those live outside `hosting.public` and, for
   * `.next`, behind a dot-directory. Entries are `root`-relative; missing ones
   * are skipped silently, since an unbuilt project is not a finding.
   * Omitted means scan `root` itself.
   */
  readonly dirs?: readonly string[];
}

/** One offending artifact, with the catalog labels that identify the finding. */
export interface InlinedFirebaseHit {
  /** `root`-relative path of the file, in the caller's own spelling. */
  readonly file: string;
  /** The first matching host found in it. */
  readonly host: string;
  /** That host's catalog service label, used verbatim in messages. */
  readonly service: string;
}

/**
 * Scan for inlined SDK fingerprints. Bounded: depth 4 per scanned directory,
 * 200 script files total, first hit per file.
 *
 * The host is reported alongside the file because the pre-flight check names
 * the service ("Cloud Firestore") rather than just the path.
 */
export function scanInlinedFirebaseHits(
  root: string,
  opts: InlinedScanOptions,
): InlinedFirebaseHit[] {
  const hits: InlinedFirebaseHit[] = [];
  let scanned = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES) return;
      const name = entry.name;
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        // The pyric namespace itself never lands in hosting.public, but a
        // node_modules inside a served dir would be a scan-cost trap.
        // Dot-directories (.next, .git, .pyric) are internal caches and must
        // be ignored. An explicitly requested dir is still scanned even when
        // dot-prefixed: the caller named it, so it is a target, not an
        // incidental cache.
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(path, relPath, depth + 1);
        continue;
      }
      if (!SCRIPT_FILE.test(name)) continue;
      scanned++;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue; // unreadable asset
      }
      const host = opts.hosts.find((candidate) => text.includes(candidate));
      if (host === undefined) continue;
      hits.push({ file: relPath, host, service: lookupGoogleEndpoint(host)?.service ?? host });
    }
  };
  if (opts.dirs === undefined) {
    walk(root, '', 0);
    return hits;
  }
  for (const sub of opts.dirs) {
    const target = resolve(root, sub);
    if (!existsSync(target)) continue;
    // `rel` seeds with the caller's own spelling so hits read back as the path
    // they asked about (`.next/server/chunk.js`).
    walk(target, sub.replace(/[\\/]+$/, '').replace(/\\/g, '/'), 0);
  }
  return hits;
}
