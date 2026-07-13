/**
 * @pyric/cli' OWN package version, resolved at runtime — the version-skew
 * stamp both ends of the worker relay compare (integration-smoke fix: an old
 * `pyric dev` accepting a newer client's frame and dying mid-handling used to
 * surface as a bare 30s timeout with no hint).
 *
 * Resolution order:
 *   1. A standalone `bun build --compile` binary's baked version
 *      (`globalThis.__PYRIC_EMBEDDED__.version` — see serve/standalone-assets).
 *   2. The nearest `package.json` walking up from THIS module (dist/ or src/),
 *      i.e. the @pyric/cli install actually executing.
 *   3. `'0.0.0'` when neither resolves (never throws).
 *
 * Node-only (node:fs / node:url) — do NOT import from browser-bundled modules
 * (`bridge/protocol.ts`, the bridge client, worker code). The server
 * (`bridge/server/peer.ts`) and the Node remote client (`remote/index.ts`)
 * are the intended consumers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function cliVersion(): string {
  if (cached !== null) return cached;
  const embedded = (
    globalThis as { __PYRIC_EMBEDDED__?: { version?: string } }
  ).__PYRIC_EMBEDDED__;
  if (typeof embedded?.version === 'string' && embedded.version.length > 0) {
    cached = embedded.version;
    return cached;
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
