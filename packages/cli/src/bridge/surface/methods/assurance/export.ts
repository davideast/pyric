/**
 * Write the campaign out as a bundle: its target, its evidence, and its cases.
 *
 * The bundle is redacted before it leaves the campaign, so a seeded password
 * and an actor's own credential are replaced rather than written to a file the
 * project keeps. A caller that names a path gets the bundle on disk inside the
 * project directory; a caller that names none gets it back in the result.
 */
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { campaignId } from '../../arguments/assurance.js';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'export',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'export(campaignId, path?)',
  description:
    'Export the campaign, redacted.',
  args: z.object({
    campaignId,
    path: z
      .string()
      .optional()
      .describe('Where to write the bundle, relative to the project directory.'),
  }),
  operation: 'export_assurance_campaign',
  renames: { runId: 'campaignId', out: 'path', file: 'path' },
  example: { campaignId: 'first-pass', path: '.pyric/assurance/first-pass.json' },
  async handler(args, ctx) {
    // The path is settled before the campaign is exported, so a call that
    // names somewhere the bundle cannot be written is refused rather than
    // exporting a bundle and then dropping it.
    if (args.path === undefined) {
      return callAssuranceOperation(ctx, 'firebase_assurance_export', {
        campaignId: args.campaignId,
      });
    }
    const resolved = projectPathWithin(
      ctx.projectDir,
      String(args.path),
      'path',
      failFor('assurance', 'export'),
    );
    if (!('path' in resolved)) return resolved;

    const exported = await callAssuranceOperation(ctx, 'firebase_assurance_export', {
      campaignId: args.campaignId,
    });
    if (!exported.ok) return exported;
    try {
      mkdirSync(dirname(resolved.path), { recursive: true });
      writeFileSync(resolved.path, `${JSON.stringify(exported.data, null, 2)}\n`, 'utf8');
    } catch (error) {
      return operationFailure(
        `The campaign exported but was not written to '${String(args.path)}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      ok: true,
      summary: `${exported.summary} Written to '${String(args.path)}'.`,
      data: { path: args.path, bundle: exported.data },
    };
  },
} satisfies MethodRecord;
