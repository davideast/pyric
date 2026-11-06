/**
 * Capture store for `pyric dev --capture` — the write-side of the
 * `pyric verify` loop.
 *
 * `pyric dev` captures the in-page sandbox session (history + snapshot +
 * rules) and pushes it here whenever the sandbox changes. `pyric verify`
 * (no positional arg) reads `CAPTURE_RELATIVE_PATH` and replays it against
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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The `.gitignore` line the capture step adds. */
const PYRIC_IGNORE_LINE = '.pyric/';

/** A `.gitignore` line that already ignores `.pyric/`. */
const IGNORES_PYRIC = /^\/?\.pyric\/?(?:\*\*?)?$/;

/** The app's `.gitignore`, or an empty one when it has none. */
function readGitignore(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Make sure the app's `.gitignore` ignores `.pyric/`, creating the file when
 * absent: a capture holds live calls' claim values and documents, which
 * must never reach a commit. Never throws: a read-only project still captures.
 */
function ensureGitignored(projectDir: string): void {
  const path = join(projectDir, '.gitignore');
  const text = readGitignore(path);
  const isIgnored = text.split(/\r?\n/).some((line) => IGNORES_PYRIC.test(line.trim()));
  if (isIgnored) return;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  try {
    appendFileSync(path, `${separator}${PYRIC_IGNORE_LINE}\n`);
  } catch {
    // An unwritable .gitignore leaves the capture as it is.
  }
}

/**
 * Relative path (from project root) where the serve capture lives.
 *
 * This is where the file is written, so this is where its name is declared.
 * `pyric verify`, the surface's session arguments, and the eval seeder all
 * read the same file and import this rather than spelling it again. Written
 * with forward slashes because it is quoted verbatim in method descriptions
 * and in what a caller types; every reader joins it onto a directory.
 */
export const CAPTURE_RELATIVE_PATH = '.pyric/last-session.json';

export interface CaptureStore {
  /** Absolute path of the capture file (`<projectDir>/.pyric/last-session.json`). */
  path: string;
  /**
   * Write the fixture JSON verbatim. Creates `.pyric/` if absent.
   * The body is the page's own JSON-serialized fixture; we store it
   * as-is so `pyric verify` can hand it straight to the replay engine.
   */
  write(fixtureJson: string): void;
  /**
   * Read back the last-written fixture JSON verbatim, or `null` when the
   * capture file does not exist yet (nothing captured this run). Powers
   * GET /__pyric/capture, which the served SharedWorker fetches on boot to
   * re-hydrate its in-memory event history after a worker death.
   */
  read(): string | null;
}

/**
 * Create a capture store rooted at `projectDir`. Returns a tiny sink that
 * mirrors the minimal shape of `state-store.ts`: a `path` for banner
 * reporting and a `write` for the route handler.
 */
export function createCaptureStore(projectDir: string): CaptureStore {
  const path = join(projectDir, CAPTURE_RELATIVE_PATH);
  let isIgnored = false;
  return {
    path,
    write(fixtureJson: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fixtureJson);
      if (isIgnored) return;
      ensureGitignored(projectDir);
      isIgnored = true;
    },
    read(): string | null {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // ENOENT (nothing captured yet) or any read error → treat as absent.
        return null;
      }
    },
  };
}
