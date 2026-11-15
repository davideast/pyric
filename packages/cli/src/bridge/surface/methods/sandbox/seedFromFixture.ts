/** Load a fixture written by `exportFixture` on top of the live sandbox. */
import { z } from 'zod';
import { applyFixture, readFixtureFile } from '../../fixture.js';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { failFor } from '../../method-validation.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'seedFromFixture',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'seedFromFixture(path)',
  description: 'Load a fixture.',
  args: z.object({ path: z.string() }),
  operation: 'seed_sandbox_fixture',
  example: { path: 'fixtures/scenario.json' },
  async handler(args, ctx) {
    const given = String(args.path);
    const resolved = projectPathWithin(
      ctx.projectDir,
      given,
      'path',
      failFor('sandbox', 'seedFromFixture'),
    );
    if (!('path' in resolved)) return resolved;
    let fixture: ReturnType<typeof readFixtureFile>;
    try {
      fixture = readFixtureFile(resolved.path);
    } catch (error) {
      if (error instanceof Error) return operationFailure(error.message);
      return operationFailure(String(error));
    }
    if (fixture === null) {
      return operationFailure(`No fixture file at '${given}'.`);
    }
    const refusals = await applyFixture(ctx.sandbox, fixture);
    const docs = Object.keys(fixture.firestore ?? {}).length;
    const users = fixture.users?.length ?? 0;
    const loaded = `Loaded a fixture of ${docs} doc(s) and ${users} user(s) from ${given}.`;
    let summary = loaded;
    const data: { path: string; docs: number; users: number; refusedRules?: string[] } = {
      path: given,
      docs,
      users,
    };
    if (refusals.length > 0) {
      summary = `${loaded} Rules not installed, the sandbox keeps the rules in force: ${refusals.join(' ')}`;
      data.refusedRules = refusals;
    }
    return {
      ok: true,
      summary,
      data,
    };
  },
} satisfies MethodRecord;
