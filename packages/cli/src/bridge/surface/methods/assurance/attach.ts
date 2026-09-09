/**
 * Clone the sandbox this process owns into a fresh campaign.
 *
 * The campaign reads the live sandbox once and then judges its own copy: the
 * live state is never probed or mutated, and the campaign forbids the network.
 * A served bridge reaches its sandbox through a loopback origin it has to
 * assert; a process that owns the sandbox reads it directly, so this method
 * names no URL.
 */
import { z } from 'zod';

import { campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation, OWNED_SANDBOX_URL } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'attach',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'attach(campaignId?, maxRuns?)',
  description:
    'Clone this sandbox into a new campaign, read-only.',
  args: z.object({
    campaignId: campaignId
      .optional()
      .describe('A name for the campaign. One is generated when absent.'),
    maxRuns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The most probe runs this campaign may spend.'),
  }),
  operation: 'attach_assurance_target',
  renames: { id: 'campaignId', campaign: 'campaignId' },
  example: { campaignId: 'first-pass' },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_attach', {
      ...args,
      url: OWNED_SANDBOX_URL,
    });
  },
} satisfies MethodRecord;
