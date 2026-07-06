/**
 * Unit tests for `generate_fixture_from_session`. Exercises the pure
 * builder functions extracted from the handler — `sanitizeFilename`
 * and `buildFixturePayload` — so the load-bearing logic is verified
 * without spinning up a real sandbox.
 *
 * The handler's `execute()` is a thin wrapper over `buildFixturePayload`
 * plus `getRunner().getSandbox()` / `env.snapshot()` reads. The wrapper
 * itself is intentionally minimal so testing the wrapper would mostly
 * be testing the runner singleton — covered indirectly by Playwright.
 */
import { describe, test, expect } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  sanitizeFilename,
  buildFixturePayload,
} from './generate-fixture-from-session.shared';

const MINIMAL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /docs/{id} {
      allow read, write: if true;
    }
  }
}`;

describe('sanitizeFilename', () => {
  test('passes through a clean kebab-case name and appends .json', () => {
    expect(sanitizeFilename('alice-first-note', 'session')).toBe('alice-first-note.json');
  });

  test('lowercases mixed case', () => {
    expect(sanitizeFilename('AliceFirstNote', 'session')).toBe('alicefirstnote.json');
  });

  test('replaces spaces and punctuation with dashes', () => {
    expect(sanitizeFilename('alice creates a note!', 'session')).toBe('alice-creates-a-note.json');
  });

  test('collapses runs of dashes to a single dash', () => {
    expect(sanitizeFilename('alice---note', 'session')).toBe('alice-note.json');
  });

  test('strips leading/trailing dashes after sanitization', () => {
    expect(sanitizeFilename('!!!alice!!!', 'session')).toBe('alice.json');
  });

  test('falls back when the cleaned suggestion is empty', () => {
    // Pure punctuation collapses to '' after the dash-strip; the
    // fallback wins. Guard against empty filename slipping through.
    expect(sanitizeFilename('!!!', 'session-fallback')).toBe('session-fallback.json');
  });

  test('falls back when suggestion is undefined', () => {
    expect(sanitizeFilename(undefined, 'session-default')).toBe('session-default.json');
  });

  test('preserves a pre-existing .json extension instead of doubling it', () => {
    expect(sanitizeFilename('alice.json', 'session')).toBe('alice.json');
  });
});

describe('buildFixturePayload', () => {
  // Synthetic write event that matches WriteSandboxEvent's required
  // shape. Used to exercise the captured-shape code path without
  // spinning up a sandbox; structural fidelity matters because the
  // replay engine parses these back from JSON.
  const SYNTHETIC_WRITE: SandboxEvent = {
    kind: 'write',
    id: 'w1',
    at: 1_700_000_000_000,
    method: 'create',
    path: 'docs/alice',
    auth: { uid: 'alice', token: {} },
    data: { title: 'hi' },
    priorState: null,
    nextState: { title: 'hi' },
    requestTime: { seconds: 1_700_000_000, nanoseconds: 0 },
  };

  test('refuses an empty session with ok:false + explanatory summary', () => {
    const out = buildFixturePayload([], {}, { rules: MINIMAL_RULES });
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/empty session/);
    // Even on refusal, the fixture skeleton is returned so the agent
    // can echo back what was attempted.
    expect(out.data.fixture.rules).toBe(MINIMAL_RULES);
    expect(out.data.fixture.events).toEqual([]);
    expect(out.data.fixture.state).toEqual({});
  });

  test('captures events + state with correct stats', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, { rules: MINIMAL_RULES });
    expect(out.ok).toBe(true);
    expect(out.data.stats.events).toBe(1);
    expect(out.data.stats.documents).toBe(1);
    expect(out.data.stats.bytes).toBe(out.data.serialized.length);
    expect(out.data.fixture.events).toEqual([SYNTHETIC_WRITE]);
    expect(out.data.fixture.state).toEqual(state);
  });

  test('omits description when none provided', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, { rules: MINIMAL_RULES });
    expect(out.ok).toBe(true);
    expect(out.data.fixture.description).toBeUndefined();
  });

  test('omits description when an empty/whitespace string is provided', () => {
    // Guard against a description field that's just whitespace
    // leaving a literal "   " in the fixture — the JSON would still
    // parse but it's noisy in the CI output.
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, {
      rules: MINIMAL_RULES,
      description: '   ',
    });
    expect(out.ok).toBe(true);
    expect(out.data.fixture.description).toBeUndefined();
  });

  test('includes description verbatim when provided non-empty', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, {
      rules: MINIMAL_RULES,
      description: 'alice creates her first note',
    });
    expect(out.ok).toBe(true);
    expect(out.data.fixture.description).toBe('alice creates her first note');
  });

  test('serialized JSON is valid and round-trips to the fixture', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, {
      rules: MINIMAL_RULES,
      description: 'roundtrip',
    });
    expect(out.ok).toBe(true);
    const parsed = JSON.parse(out.data.serialized);
    expect(parsed.description).toBe('roundtrip');
    expect(parsed.rules).toBe(MINIMAL_RULES);
    expect(parsed.events).toEqual([SYNTHETIC_WRITE]);
    expect(parsed.state).toEqual(state);
  });

  test('filename derives from description when suggestedFilename is absent', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, {
      rules: MINIMAL_RULES,
      description: 'alice creates her first note',
    });
    expect(out.ok).toBe(true);
    expect(out.data.filename).toBe('session-alice-creates-her-first-note.json');
  });

  test('filename uses suggestedFilename when provided, sanitized', () => {
    const state = { 'docs/alice': { title: 'hi' } };
    const out = buildFixturePayload([SYNTHETIC_WRITE], state, {
      rules: MINIMAL_RULES,
      suggestedFilename: 'Alice First Note!',
    });
    expect(out.ok).toBe(true);
    expect(out.data.filename).toBe('alice-first-note.json');
  });

  test('captures state-only sessions (events empty, docs non-empty)', () => {
    // The agent may have used admin-bypass to seed fixture state and
    // hasn't yet exercised the rules — that's still a meaningful
    // baseline, so the tool should capture it.
    const state = { 'docs/alice': { title: 'pre-seeded' } };
    const out = buildFixturePayload([], state, { rules: MINIMAL_RULES });
    expect(out.ok).toBe(true);
    expect(out.data.stats.events).toBe(0);
    expect(out.data.stats.documents).toBe(1);
  });

  test('captures event-only sessions (events non-empty, state empty)', () => {
    // Read-only flows or denial-only sessions produce events without
    // changing state. Also a legitimate capture target.
    const out = buildFixturePayload([SYNTHETIC_WRITE], {}, { rules: MINIMAL_RULES });
    expect(out.ok).toBe(true);
    expect(out.data.stats.events).toBe(1);
    expect(out.data.stats.documents).toBe(0);
  });
});
