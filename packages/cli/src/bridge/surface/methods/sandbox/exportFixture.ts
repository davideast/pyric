/**
 * Write a fixture of the live sandbox's state to a file.
 *
 * The fixture carries no password. A sandbox password is a credential, and the
 * agent surface has no method that writes one to disk: the human path for a
 * state file that keeps real passwords is `pyric snapshot --include-passwords`,
 * where a person chooses it at a terminal.
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
  signature: 'exportFixture(path)',
  description: 'Write the sandbox to a seed fixture file.',
  args: z.object({
    path: z.string().describe('Where to write the fixture, inside the project directory.'),
  }),
  operation: 'export_sandbox_fixture',
  example: { path: 'fixtures/scenario.json' },
  async handler(args, ctx) {
    const given = String(args.path);
    const resolved = projectPathWithin(
      ctx.projectDir,
      given,
      'path',
      failFor('sandbox', 'exportFixture'),
    );
    if (!('path' in resolved)) return resolved;
    const fixture = await buildFixture(ctx.sandbox);
    writeFixtureFile(resolved.path, fixture);
    const docs = Object.keys(fixture.firestore ?? {}).length;
    const users = fixture.users?.length ?? 0;
    return {
      ok: true,
      summary: `Wrote a fixture of ${docs} doc(s) and ${users} user(s) to ${given}.`,
      data: { path: given, docs, users },
    };
  },
} satisfies MethodRecord;
