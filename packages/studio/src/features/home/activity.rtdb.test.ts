/**
 * Empirical check: RTDB writes reach the Home activity feed.
 *
 * These tests do NOT hand-craft event shapes. They run real RTDB writes
 * through the SAME `pyric/database/modular` handles the served worker's
 * `rtdb.set` handler resolves (`serve/worker/host.ts` → `lensRtdb`):
 *
 *   - app-session / `as` / anon lens → `getDatabase(...)` → the rule-gated
 *     backend path, which emits `operation` + `commit` + `service_mutation`.
 *   - admin lens (Studio's RTDB viewer edits via `workerAdminSetRtdbValue`,
 *     agent admin ops) → `getAdminDatabase(...)` → `adminSet`, which emits
 *     `operation` (result `not-applicable`, origin `admin`) + `commit`
 *     (detail `{ admin: true }`) and NO `service_mutation`.
 *
 * Then every emitted event is fed through `toActivityRow` and we assert the
 * write projects into the feed with an RTDB target — exactly once.
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
  ref,
  sandbox as rtdbSandbox,
  set,
} from 'pyric/database/modular';
import { toActivityRow, type ActivityRow } from './activity.js';

/** Run `write` on a fresh sandbox and return ONLY the events it emitted. */
async function eventsFromRtdbWrite(
  write: (sandbox: ReturnType<typeof initializeSandbox>) => Promise<void> | void,
): Promise<readonly SandboxEvent[]> {
  const sandbox = initializeSandbox();
  rtdbSandbox.setRules(getDatabase(sandbox), {
    rules: { '.read': true, '.write': true },
  });
  const before = sandbox.history().length;
  await write(sandbox);
  return sandbox.history().slice(before);
}

function activityRows(events: readonly SandboxEvent[]): ActivityRow[] {
  return events
    .map((e) => toActivityRow(e))
    .filter((r): r is ActivityRow => r !== null);
}

describe('home activity — RTDB writes as the worker emits them', () => {
  it('projects a rule-gated write (app-session lens path) once, with an rtdb target', async () => {
    const events = await eventsFromRtdbWrite(async (sandbox) => {
      const db = getDatabase(sandbox); // = the worker's sessionRtdb handle
      await set(ref(db, '/rooms/r1'), { topic: 'general' });
    });

    // Sanity: the write really emitted the worker-visible kinds.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('operation');
    expect(kinds).toContain('commit');
    expect(kinds).toContain('service_mutation');

    const rows = activityRows(events);
    const rtdbRows = rows.filter((r) => r.target?.tab === 'rtdb');
    expect(rtdbRows.length).toBe(1); // exactly once — no double row from commit
    expect(rtdbRows[0].denied).toBe(false);
    expect(rtdbRows[0].summary).toContain('rtdb');
    expect(rtdbRows[0].summary).toContain('/rooms/r1');
  });

  it('projects an admin-lens write (Studio RTDB viewer / agent admin path) with an rtdb target', async () => {
    const events = await eventsFromRtdbWrite(async (sandbox) => {
      // = the worker's `lensRtdb(ctx, { mode: 'admin' })` handle, the one
      // Studio's setRtdbValue resolves.
      const db = getAdminDatabase(sandbox);
      await set(ref(db, '/settings/theme'), 'dark');
    });

    // The admin plane emits NO service_mutation — the commit is the only
    // committed-write signal for this path.
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain('service_mutation');
    expect(kinds).toContain('commit');

    const rows = activityRows(events);
    const rtdbRows = rows.filter((r) => r.target?.tab === 'rtdb');
    expect(rtdbRows.length).toBe(1);
    expect(rtdbRows[0].summary).toContain('/settings/theme');
  });
});
