/**
 * Cut a demonstrated counterexample down to the smallest case that still shows it.
 *
 * The reducer removes payload fields and keeps only the removals under which
 * the probe still classifies the same way, so what is left is the part of the
 * request the rules actually failed on.
 */
import { z } from 'zod';

import { campaignId, probeId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'minimize',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'minimize(campaignId, probeId)',
  description: 'Shrink a counterexample.',
  args: z.object({ campaignId, probeId }),
  operation: 'minimize_assurance_probe',
  renames: { runId: 'probeId', probe: 'probeId' },
  example: { campaignId: 'first-pass', probeId: 'probe-1' },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_minimize', args);
  },
} satisfies MethodRecord;
