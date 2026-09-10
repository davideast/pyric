/**
 * Write a fixture of the live sandbox's state to a file.
 *
 * The fixture carries the sandbox's passwords, because a sandbox password is a
 * seeded test value rather than a credential, and a fixture that dropped it
 * reads back a user who cannot sign in. `excludePasswords` leaves them out for
 * a fixture that is going somewhere those values should not follow.
 *
 * `includePasswords` is refused in this record's own words rather than renamed.
 * A rename reads as "you meant this one", and pointing `includePasswords` at
 * `excludePasswords` inverts the call, so the rule and the edit are stated
 * here and the shared validator asks this record before it guesses.
 */
import { z } from 'zod';
import { buildFixture, writeFixtureFile } from '../../fixture.js';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'exportFixture',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'exportFixture(path, excludePasswords?)',
  description: 'Write a seed fixture.',
  args: z.object({
    path: z.string().describe('Where to write the fixture, inside the project directory.'),
    excludePasswords: z
      .boolean()
      .optional()
      .describe(
        'Leave the seeded passwords out of the fixture. Default false: a fixture carries them, so a user it seeds back can sign in.',
      ),
  }),
  operation: 'export_sandbox_fixture',
  example: { path: 'fixtures/scenario.json' },
  validate: (args, { fail }) => {
    if (!('includePasswords' in args)) return null;
    return fail(
      "unknown argument 'includePasswords'. A fixture carries the seeded passwords by default, so there is nothing to turn on.",
      "Drop 'includePasswords', or pass 'excludePasswords' as true to leave the passwords out.",
      'includePasswords',
    );
  },
  async handler(args, ctx) {
    const given = String(args.path);
    const resolved = projectPathWithin(
      ctx.projectDir,
      given,
      'path',
      failFor('sandbox', 'exportFixture'),
    );
    if (!('path' in resolved)) return resolved;
    const excludePasswords = args.excludePasswords === true;
    const fixture = await buildFixture(ctx.sandbox, excludePasswords);
    writeFixtureFile(resolved.path, fixture);
    const docs = Object.keys(fixture.firestore ?? {}).length;
    const users = fixture.users?.length ?? 0;
    return {
      ok: true,
      summary: `Wrote a fixture of ${docs} doc(s) and ${users} user(s) to ${given}.`,
      data: { path: given, docs, users, excludePasswords },
    };
  },
} satisfies MethodRecord;
