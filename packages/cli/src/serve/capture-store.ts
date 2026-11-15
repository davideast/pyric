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
import {
  CAPTURE_RELATIVE_PATH,
  countDeniedEvents,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
} from '../verify/file-format.js';

export { CAPTURE_RELATIVE_PATH, PREVIOUS_CAPTURE_RELATIVE_PATH };

const hostedCaptureManagedSandboxes = new WeakSet<object>();

/** Record that a sandbox's session capture lifecycle is managed by a hosted runtime. */
export function markHostedCaptureManaged(sandbox: object): void {
  hostedCaptureManagedSandboxes.add(sandbox);
}

/** Whether a sandbox's session capture lifecycle is managed by a hosted runtime. */
export function isHostedCaptureManaged(sandbox: object): boolean {
  return hostedCaptureManagedSandboxes.has(sandbox);
}

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
export function ensureGitignored(projectDir: string): void {
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

/** Summary of recorded events in a serialized capture fixture. */
export interface CaptureSummary {
  eventCount: number;
  denialCount: number;
}

/**
 * Count total and denied events inside a serialized verify capture JSON string.
 * Returns `null` when the string is not a JSON object with an `events` array.
 */
export function summarizeCaptureJson(raw: string): CaptureSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  return { eventCount: events.length, denialCount: countDeniedEvents(events) };
}

export interface CaptureStore {
  /** Absolute path of the capture file (`<projectDir>/.pyric/last-session.json`). */
  path: string;
  /** Absolute path of the rotated prior capture (`<projectDir>/.pyric/previous-session.json`). */
  previousPath: string;
  /**
   * Write the fixture JSON verbatim. Creates `.pyric/` if absent.
   * When a clearing flush (0 events) overwrites a non-empty capture, the
   * prior capture is copied verbatim to `.pyric/previous-session.json` first.
   * An empty flush never overwrites an already-preserved previous capture.
   */
  write(fixtureJson: string): void;
  /**
   * Read back the last-written fixture JSON verbatim, or `null` when the
   * capture file does not exist yet (nothing captured this run). Powers
   * GET /__pyric/capture, which the served SharedWorker fetches on boot to
   * re-hydrate its in-memory event history after a worker death.
   */
  read(): string | null;
  /** Read back the preserved previous capture verbatim, or `null` when absent. */
  readPrevious(): string | null;
  /**
   * Persist a non-empty capture verbatim to `.pyric/previous-session.json`.
   * Returns `false` without touching disk when `fixtureJson` holds zero events.
   */
  preservePrevious(fixtureJson: string): boolean;
  /**
   * Write a cleared active capture to `.pyric/last-session.json` without
   * rotating `.pyric/previous-session.json`. Used immediately after
   * `preservePrevious` so a later debounced empty flush sees 0 events and
   * cannot overwrite the preserved capture.
   */
  clearActive(fixtureJson: string): void;
}

/**
 * Create a capture store rooted at `projectDir`. Returns a tiny sink that
 * mirrors the minimal shape of `state-store.ts`: a `path` for banner
 * reporting and a `write` for the route handler.
 */
export function createCaptureStore(projectDir: string): CaptureStore {
  const path = join(projectDir, CAPTURE_RELATIVE_PATH);
  const previousPath = join(projectDir, PREVIOUS_CAPTURE_RELATIVE_PATH);
  let isIgnored = false;

  function markIgnored(): void {
    if (isIgnored) return;
    ensureGitignored(projectDir);
    isIgnored = true;
  }

  function readFileOrNull(filePath: string): string | null {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      // ENOENT (nothing captured yet) or any read error -> treat as absent.
      return null;
    }
  }

  function writeVerbatim(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    markIgnored();
  }

  return {
    path,
    previousPath,
    write(fixtureJson: string): void {
      const incoming = summarizeCaptureJson(fixtureJson);
      if (incoming !== null && incoming.eventCount === 0) {
        const existing = readFileOrNull(path);
        if (existing !== null) {
          const prior = summarizeCaptureJson(existing);
          if (prior !== null && prior.eventCount > 0) {
            writeVerbatim(previousPath, existing);
          }
        }
      }
      writeVerbatim(path, fixtureJson);
    },
    read(): string | null {
      return readFileOrNull(path);
    },
    readPrevious(): string | null {
      return readFileOrNull(previousPath);
    },
    preservePrevious(fixtureJson: string): boolean {
      const summary = summarizeCaptureJson(fixtureJson);
      if (summary === null || summary.eventCount === 0) return false;
      writeVerbatim(previousPath, fixtureJson);
      return true;
    },
    clearActive(fixtureJson: string): void {
      writeVerbatim(path, fixtureJson);
    },
  };
}
