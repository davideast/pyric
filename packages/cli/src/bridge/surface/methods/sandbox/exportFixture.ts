/**
 * Write a fixture of the live sandbox's state to a file.
 *
 * `exportFixture` is a `write` method, not `destructive`: it discards nothing
 * live. `includePasswords` is the one field this record refuses on its own,
 * because the shared destructive-confirm check only fires for a `destructive`
 * effect class, and a fixture that leaves real password hashes on disk is a
 * per-argument risk this method carries alone.
 */
import { z } from 'zod';
import { buildFixture, fixturePathWithin, writeFixtureFile } from '../../fixture.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'exportFixture',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'exportFixture(path, includePasswords?)',
  description:
    'Write the sandbox to a fixture file under the project directory. includePasswords requires confirm: true, because password hashes then leave the sandbox.',
  args: z.object({
    path: z.string(),
    includePasswords: z.boolean().optional(),
    confirm: z.boolean().optional(),
  }),
  operation: 'export_sandbox_fixture',
  example: { path: 'fixtures/scenario.json' },
  validate(args, { fail }) {
    if (args.includePasswords === true && args.confirm !== true) {
      return fail(
        'includePasswords is true. Password hashes leave the sandbox onto disk.',
        'Pass confirm: true to proceed, or omit includePasswords.',
        'confirm',
      );
    }
    return null;
  },
  async handler(args, ctx) {
    const given = String(args.path);
    const resolved = fixturePathWithin(ctx.projectDir, given);
    if ('error' in resolved) {
      return { ok: false, summary: resolved.error };
    }
    const includePasswords = args.includePasswords === true;
    const fixture = await buildFixture(ctx.sandbox, includePasswords);
    writeFixtureFile(resolved.path, fixture);
    const docs = Object.keys(fixture.firestore ?? {}).length;
    const users = fixture.users?.length ?? 0;
    return {
      ok: true,
      summary: `Wrote a fixture of ${docs} doc(s) and ${users} user(s) to ${given}.`,
      data: { path: given, docs, users, includePasswords },
    };
  },
} satisfies MethodRecord;
