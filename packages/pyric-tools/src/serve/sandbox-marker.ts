/**
 * The sandbox-build marker — the single source of truth shared by the three
 * places that produce or read it: the Vite plugin stamps it into a
 * `vite build --mode pyric` output's `index.html`; `pyric dev` trusts it (a
 * marked dist bundles pyric's in-page adapters, so its assets never inline the
 * real SDK and the inlined-firebase scanner is skipped).
 *
 * Dependency-free (fs/path only) so the dev server can read it without pulling
 * in the browser bundler.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The attribute stamped into a sandbox build's `index.html` head. Presence in
 *  an asset's text is the signal — the value is fixed, never parsed. */
export const SANDBOX_BUILD_MARKER = 'data-pyric-sandbox-build';

/** The full `<meta>` tag the plugin injects at the start of `<head>`. */
export const SANDBOX_BUILD_META = `<meta name="pyric-sandbox-build" content="1" ${SANDBOX_BUILD_MARKER}>`;

/** True when `dir`'s `index.html` carries the sandbox-build marker. Missing or
 *  unreadable index → false (treated as an ordinary build). */
export function hasSandboxBuildMarker(dir: string): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  try {
    return readFileSync(index, 'utf8').includes(SANDBOX_BUILD_MARKER);
  } catch {
    return false;
  }
}
