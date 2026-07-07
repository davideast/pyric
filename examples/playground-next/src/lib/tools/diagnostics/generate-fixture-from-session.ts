/**
 * `generate_fixture_from_session` — capture the in-browser sandbox's
 * current session as a replay fixture matching the schema consumed by
 * `examples/replay/ci/check-fixtures.ts`. The agent supplies a
 * description + the rules source the fixture is for; the tool reads
 * `sandbox.history()` and `env.snapshot()`, packages them, and returns
 * pretty-printed JSON for the agent to surface back to the user.
 *
 * Why this exists: when an agent generates a feature and the user
 * validates it works, that's a "known good" snapshot. Without a tool
 * to capture it, the snapshot dies with the session — next regression
 * costs the same human-validation work to detect. Capturing the
 * session as a fixture lets `check-fixtures.ts` re-replay it forever:
 * the next rule change that breaks this user flow fails the CI gate
 * without anyone re-typing the test by hand.
 *
 * Design call (NOT re-litigated this PR):
 *   - **No filesystem write.** The browser context can't write to the
 *     user's repo. The tool returns the JSON in `data.serialized` plus
 *     a suggested filename; the agent renders it in a code block (or a
 *     future companion tool handles persistence — out of scope here).
 *   - **Snapshot only — no events filter.** Capturing a *partial*
 *     history is brittle: the captured writes have causal dependencies
 *     on earlier writes that aren't replayable in isolation. If the
 *     agent wants narrower coverage, it should reset the sandbox to
 *     a known starting point first, perform the targeted flow, and
 *     capture from there. Splitting one captured session into multiple
 *     fixtures by event-prefix is an attractive trap; don't ship it.
 *   - **Rules source is supplied by the agent, not pulled from the
 *     editor store.** The rules that produced the session are
 *     load-bearing context for the fixture; we ask the agent to pass
 *     them explicitly to keep the capture self-describing. Same shape
 *     as `simulate_firestore_write`.
 *   - **Pure helpers live in `generate-fixture-from-session.shared.ts`.**
 *     The handler's payload-building logic is split out so unit tests
 *     can exercise it without the runner singleton chain pulling in
 *     workspace deps that aren't always built at test time.
 *
 * Gating: unconditional. No auth, no project, no network — runs
 * entirely against the in-process sandbox. Available the moment the
 * master diagnostics switch is on and the per-tool flag is true.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import {
  buildFixturePayload,
  type GenerateFixtureFromSessionArgs,
  type GenerateFixtureFromSessionData,
} from './generate-fixture-from-session.shared';

export type {
  GenerateFixtureFromSessionArgs,
  GenerateFixtureFromSessionData,
} from './generate-fixture-from-session.shared';

export function buildGenerateFixtureFromSessionHandler(): ToolHandler<
  GenerateFixtureFromSessionArgs,
  GenerateFixtureFromSessionData
> {
  return {
    name: 'generate_fixture_from_session',
    description:
      'Capture the current in-browser sandbox session — every event the sandbox saw + the final state of every document — as a JSON fixture in the format `examples/replay/ci/check-fixtures.ts` consumes. Use this when the user has just validated a feature works correctly: the captured fixture becomes a permanent CI regression gate that re-replays the same flow against future rule edits and flags any divergence. Returns the serialized JSON in `data.serialized`; surface it to the user with a suggested filename under `examples/replay/ci/fixtures/`. No filesystem write — the tool runs entirely in the browser. Resets clear history; if the user just hit reset, capture again after reproducing the flow.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'Short human-readable label for the fixture, e.g. "alice creates her first note". Surfaces in the CI output when this fixture fails replay.',
        },
        rules: {
          type: 'string',
          description:
            'Full rules source the session was captured under. Stored on the fixture for documentation; the replay CLI replays against the CURRENT rules and flags divergences relative to this captured baseline.',
        },
        suggestedFilename: {
          type: 'string',
          description:
            'Optional filename hint (will be sanitized — lowercase, hyphens). Omit and the tool synthesizes one from the description, or a timestamp fallback.',
        },
      },
      required: ['rules'],
    },
    async execute(args) {
      // Resolve the sandbox via the runner singleton. Same pattern as
      // `seed_firestore_data_as_admin` — the runner constructs at
      // first call (idempotent), so this is safe to invoke
      // unconditionally with no warm-up handshake.
      let sandbox;
      try {
        sandbox = getPlaygroundRuntime().requireInProcessRunner('generate_fixture_from_session').getSandbox();
      } catch (e) {
        const empty = buildFixturePayload([], {}, args);
        return {
          ok: false,
          summary: `generate_fixture_from_session · ${e instanceof Error ? e.message : String(e)}`,
          data: empty.data,
        };
      }
      const events = sandbox.history();
      const env = getInternalEnv(sandbox);
      const state = env.snapshot();
      return buildFixturePayload(events, state, args);
    },
  };
}
