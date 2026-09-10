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
    const fixture = readFixtureFile(resolved.path);
    if (fixture === null) {
      return operationFailure(`No fixture file at '${given}'.`);
    }
    await applyFixture(ctx.sandbox, fixture);
    const docs = Object.keys(fixture.firestore ?? {}).length;
    const users = fixture.users?.length ?? 0;
    return {
      ok: true,
      summary: `Loaded a fixture of ${docs} doc(s) and ${users} user(s) from ${given}.`,
      data: { path: given, docs, users },
    };
  },
} satisfies MethodRecord;
