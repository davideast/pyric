/**
 * Capture store for `pyric dev --capture` — the write-side of the
 * `pyric verify` loop.
 *
 * `pyric dev` captures the in-page sandbox session (history + snapshot +
 * rules) and pushes it here whenever the sandbox changes. `pyric verify`
 * (no positional arg) reads `SERVE_CAPTURE_PATH` and replays it against
 * your current rules to surface real divergences. The loop is:
 *
 *   pyric dev  →  use your app  →  pyric verify
 *
 * The body is stored VERBATIM (the page sends its own JSON.stringify'd
 * fixture — we never re-serialize it so no wrapper-type drift is
 * introduced here). The path is intentionally next to the persist store
 * (.pyric/state/…) so it fits the same .gitignore pattern and feels like
 * one artifact family.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Relative path (from project root) where the serve capture lives.
 *  Mirrors `SERVE_CAPTURE_PATH` in `verify.ts` — keep in lockstep. */
export const CAPTURE_RELATIVE_PATH = join('.pyric', 'last-session.json');

export interface CaptureStore {
  /** Absolute path of the capture file (`<projectDir>/.pyric/last-session.json`). */
  path: string;
  /**
   * Write the fixture JSON verbatim. Creates `.pyric/` if absent.
   * The body is the page's own JSON-serialized fixture; we store it
   * as-is so `pyric verify` can hand it straight to the replay engine.
   */
  write(fixtureJson: string): void;
}

/**
 * Create a capture store rooted at `projectDir`. Returns a tiny sink that
 * mirrors the minimal shape of `state-store.ts`: a `path` for banner
 * reporting and a `write` for the route handler.
 */
export function createCaptureStore(projectDir: string): CaptureStore {
  const path = join(projectDir, CAPTURE_RELATIVE_PATH);
  return {
    path,
    write(fixtureJson: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fixtureJson);
    },
  };
}
