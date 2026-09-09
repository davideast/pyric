/**
 * Apply a stream of sandbox events onto a persisted branch.
 *
 * The events come from one of two places and never from a default: an event
 * list the caller passes, or a recorded session file the caller names. A call
 * that named neither is refused rather than reaching for the last recorded
 * session, because applying a session the caller did not name would change a
 * branch in a way nothing asked for.
 */
import { apply, type SandboxEvent } from 'pyric/sandbox';
import { loadBranch, saveBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import {
  DEFAULT_SESSION_PATH,
  branchName,
  readSessionEvents,
  refuseAmbiguousSource,
  refuseUnknownBranch,
  resolveProjectPath,
} from '../../arguments/branches.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

/** The events one call applies, or the refusal that says why it applies none. */
type EventSource = { events: SandboxEvent[] } | { refusal: OperationResult };

/** Read the events a call names, from its own list or from the session it points at. */
function eventsFor(args: Record<string, unknown>, projectDir: string): EventSource {
  if (Array.isArray(args.events)) return { events: args.events as SandboxEvent[] };
  const named = String(args.sessionPath);
  const resolved = resolveProjectPath(projectDir, named, 'sessionPath', failFor('sandbox', 'apply'));
  if (!('path' in resolved)) return { refusal: resolved };
  const events = readSessionEvents(resolved.path);
  if (events === null) {
    return {
      refusal: operationFailure(
        `No recorded session was read from '${named}'. A session file is the capture the sandbox writes, holding an events array.`,
      ),
    };
  }
  return { events };
}

export default {
  tool: 'sandbox',
  method: 'apply',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'apply(branch, events, sessionPath)',
  description: 'Re-issue events onto a branch, from a list or a session file.',
  args: z.object({
    branch: branchName,
    events: z
      .array(z.record(z.unknown()))
      .optional()
      .describe('Sandbox events in the recorded session format, applied in order.'),
    sessionPath: z
      .string()
      .optional()
      .describe(
        `A recorded session file, relative to the project directory, such as ${DEFAULT_SESSION_PATH}.`,
      ),
  }),
  operation: 'apply_sandbox_events',
  renames: { session: 'sessionPath', history: 'events', log: 'events' },
  example: { branch: 'draft', sessionPath: DEFAULT_SESSION_PATH },
  validate: (args, { fail }) => refuseAmbiguousSource(args, fail),
  async handler(args, ctx) {
    const name = String(args.branch);
    const loaded = loadBranch(ctx.projectDir, name);
    if (loaded === null) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'apply'));
    }
    const source = eventsFor(args, ctx.projectDir);
    if ('refusal' in source) {
      loaded.branch.sandbox.dispose();
      return source.refusal;
    }
    apply(loaded.branch, source.events);
    const manifest = saveBranch(ctx.projectDir, name, loaded.branch, {
      base: loaded.manifest.base,
      created: loaded.manifest.created,
    });
    loaded.branch.sandbox.dispose();
    return {
      ok: true,
      summary: `Applied ${source.events.length} events to branch '${name}'.`,
      data: { branch: name, applied: source.events.length, eventCount: manifest.eventCount },
    };
  },
} satisfies MethodRecord;
