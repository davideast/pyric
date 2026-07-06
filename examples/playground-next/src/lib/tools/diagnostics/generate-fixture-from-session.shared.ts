/**
 * Pure helpers extracted from `generate_fixture_from_session` so the
 * handler's load-bearing logic (filename sanitization, fixture build,
 * empty-session check) is unit-testable without the runner singleton
 * pulling in workspace dependencies.
 *
 * The handler module imports from here; tests import from here. The
 * handler keeps the `getRunner()` / `getInternalEnv()` calls that are
 * environment-coupled.
 */
import type { SandboxEvent } from 'pyric/sandbox';

export interface GenerateFixtureFromSessionArgs {
  /** Human-readable label for the fixture file. Included in the
   *  fixture JSON's `description` field; surfaces in
   *  `check-fixtures.ts` output when a fixture fails its replay. */
  description?: string;
  /** The rules source the session was captured under. Stored on the
   *  fixture for documentation; the replay CLI replays against the
   *  CURRENT rules and the fixture's stored `rules` is informational
   *  only — see `check-fixtures.ts`. */
  rules: string;
  /** Optional filename suggestion. Sanitized (lowercase, hyphens) and
   *  echoed back in the result's `filename` field. Doesn't affect the
   *  fixture contents — only the agent's suggested save location. */
  suggestedFilename?: string;
}

/**
 * Fixture shape mirrors `examples/replay/ci/check-fixtures.ts`'s
 * `Fixture` interface verbatim. Duplicated here (rather than imported)
 * so the playground tool doesn't take a hard dep on the example
 * directory — `examples/` isn't a packaged consumer of `~`.
 */
export interface CapturedFixture {
  description?: string;
  rules: string;
  events: SandboxEvent[];
  state: Record<string, Record<string, unknown>>;
}

export interface GenerateFixtureFromSessionData {
  /** Counts so the agent can summarize without re-walking the
   *  potentially-large fixture. */
  stats: {
    events: number;
    documents: number;
    bytes: number;
  };
  /** Suggested filename (sanitized) — agent surfaces in its save
   *  instructions to the user. */
  filename: string;
  /** Pretty-printed JSON of the fixture, ready to paste into a file
   *  under `examples/replay/ci/fixtures/`. Always 2-space indented to
   *  match the existing fixtures' style. */
  serialized: string;
  /** Same fixture as a parsed object — provided alongside `serialized`
   *  so a future companion tool (e.g. a "save fixture to gh" handler)
   *  can consume it without re-parsing. */
  fixture: CapturedFixture;
}

const FILENAME_SAFE = /[^a-z0-9-]+/g;
const MULTI_DASH = /-+/g;

/**
 * Sanitize a fixture filename. Lowercase, strip everything that isn't
 * `[a-z0-9-]`, collapse multiple dashes, strip leading/trailing
 * dashes, always append `.json`. Falls back to `fallback` when the
 * cleaned suggestion is empty (e.g. caller passed `"---"` or `"!!!"`).
 */
export function sanitizeFilename(suggested: string | undefined, fallback: string): string {
  // Strip a trailing `.json` BEFORE sanitization so the literal dot
  // doesn't get replaced. Re-append unconditionally at the end. This
  // also handles inputs like `alice.v2.json` correctly — the inner
  // dot becomes a dash, but the extension survives.
  const raw = (suggested ?? fallback).trim();
  const withoutExt = raw.endsWith('.json') ? raw.slice(0, -5) : raw;
  const cleaned = withoutExt
    .toLowerCase()
    .replace(FILENAME_SAFE, '-')
    .replace(MULTI_DASH, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) {
    // Fall back when the cleaned suggestion is empty (e.g. `"!!!"`).
    // Recurse with the fallback so its own sanitization runs too.
    return sanitizeFilename(undefined, fallback);
  }
  return `${cleaned}.json`;
}

/**
 * Pure fixture-builder. Given the captured `events`, `state`, and the
 * tool's args, produce the `GenerateFixtureFromSessionData` payload
 * the tool returns from `execute()`. Lets tests verify the empty-
 * session check, the fixture's contents, the stats math, and the
 * filename derivation without instantiating a sandbox.
 */
export function buildFixturePayload(
  events: SandboxEvent[],
  state: Record<string, Record<string, unknown>>,
  args: GenerateFixtureFromSessionArgs,
):
  | { ok: true; data: GenerateFixtureFromSessionData; summary: string }
  | { ok: false; data: GenerateFixtureFromSessionData; summary: string } {
  if (events.length === 0 && Object.keys(state).length === 0) {
    return {
      ok: false,
      summary:
        'generate_fixture_from_session · empty session — no events or state to capture. Reproduce the flow first.',
      data: {
        stats: { events: 0, documents: 0, bytes: 0 },
        filename: '',
        serialized: '',
        fixture: { rules: args.rules, events: [], state: {} },
      },
    };
  }

  const fixture: CapturedFixture = {
    rules: args.rules,
    events,
    state,
  };
  if (args.description !== undefined && args.description.trim().length > 0) {
    fixture.description = args.description;
  }

  const serialized = JSON.stringify(fixture, null, 2);
  // Fallback filename: timestamp-based, so multiple captures in a
  // session don't collide. Spelled `session-YYYYMMDD-HHmm` so it
  // sorts naturally in a directory listing.
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}`;
  const fallback = args.description
    ? `session-${args.description}`
    : `session-${stamp}`;
  const filename = sanitizeFilename(args.suggestedFilename, fallback);

  return {
    ok: true,
    summary: `generate_fixture_from_session · captured ${events.length} events + ${Object.keys(state).length} documents (${Math.ceil(serialized.length / 1024)} KB)`,
    data: {
      stats: {
        events: events.length,
        documents: Object.keys(state).length,
        bytes: serialized.length,
      },
      filename,
      serialized,
      fixture,
    },
  };
}
