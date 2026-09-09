/**
 * Run the probes against fresh sandboxes and classify what each one showed.
 *
 * Every probe runs its control and its mutation in an isolated sandbox, so a
 * probe that lands cannot change what a later probe sees, and the campaign
 * reports which showed a local counterexample and which the engine could not
 * qualify.
 */
import { z } from 'zod';

import { campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'run',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'run(campaignId, probeIds?)',
  description: 'Run the probes in fresh sandboxes and classify.',
  args: z.object({
    campaignId,
    probeIds: z
      .array(z.string().min(1))
      .optional()
      .describe('The probes to run. Absent, every probe the campaign holds runs.'),
  }),
  operation: 'run_assurance_probes',
  renames: { caseIds: 'probeIds', probes: 'probeIds' },
  example: { campaignId: 'first-pass' },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_run', args);
  },
} satisfies MethodRecord;
