/**
 * Detect a served frontend build that inlined the real Firebase SDK.
 *
 * The served import map remaps only bare `firebase/*` specifiers, so a plain
 * `vite build` that compiled the SDK into an app chunk cannot be sandboxed:
 * its calls reach real Google endpoints while the injected banner claims
 * otherwise. `cli/serve.ts` refuses such a dist rather than serving it.
 *
 * Only the SDK fingerprint hosts are matched, never the full endpoint catalog.
 * This check throws, and a dist can legitimately carry a bare callable URL, a
 * public asset URL, or a `databaseURL` literal without any Firebase SDK in it.
 *
 * Backend bundles are deliberately out of scope. `withPyric` externalizes
 * firebase and firebase-admin, the backend-bundler docs tell users to mark them
 * external, and the net guard reports real egress at runtime with attribution,
 * which a grep over build output cannot do.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_FINGERPRINT_HOSTS } from '../google-endpoints.js';

/** Depth limit for the walk. */
const MAX_DEPTH = 4;

/** Total script files read. */
const MAX_FILES = 200;

/** Script extensions worth reading in served frontend output. */
const SCRIPT_FILE = /\.(js|mjs)$/;

/**
 * Scan `dir` for inlined SDK fingerprints and return the offending paths,
 * relative to `dir`. Bounded: depth 4, 200 script files, first hit per file.
 */
export function scanForInlinedFirebase(dir: string): string[] {
  const hits: string[] = [];
  let scanned = 0;
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (scanned >= MAX_FILES) return;
      const path = join(current, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // The pyric namespace itself never lands in hosting.public, but a
        // node_modules inside a served dir would be a scan-cost trap.
        // Dot-directories (.next, .git, .pyric) are internal caches.
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
      if (SDK_FINGERPRINT_HOSTS.some((host) => text.includes(host))) hits.push(relPath);
    }
  };
  walk(dir, '', 0);
  return hits;
}
