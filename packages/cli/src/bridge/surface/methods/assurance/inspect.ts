/**
 * Read one completed probe: what ran, as whom, and what the rules decided.
 *
 * The evidence is the campaign's own record of the run, so the classification
 * a caller reads is the one the runner reached rather than a restatement of it.
 */
import { z } from 'zod';

import { campaignId, probeId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'inspect',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'inspect(campaignId, probeId)',
  description:
    "One probe's verdict.",
  args: z.object({ campaignId, probeId }),
  operation: 'inspect_assurance_probe',
  renames: { runId: 'probeId', probe: 'probeId' },
  example: { campaignId: 'first-pass', probeId: 'probe-1' },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_inspect', args);
  },
} satisfies MethodRecord;
