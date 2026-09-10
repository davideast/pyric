/**
 * Start a campaign against an explicit target rather than the running sandbox.
 *
 * The target carries its own rules, state, and accounts, so a campaign can
 * judge a ruleset nothing in this sandbox is running. Its shape is the
 * assurance library's `pyric.assurance.target.v1`, validated by the library
 * itself so the two cannot drift.
 */
import { z } from 'zod';

import { authoredRecord, campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'start',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'start(target, campaignId?, maxRuns?)',
  description:
    'Start a campaign on a target.',
  args: z.object({
    target: authoredRecord.describe(
      'The campaign target: schema pyric.assurance.target.v1, network forbid, rules, and state.',
    ),
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
  operation: 'start_assurance_campaign',
  renames: { fixture: 'target', scope: 'target' },
  example: {
    target: {
      schema: 'pyric.assurance.target.v1',
      network: 'forbid',
      rules: {},
      state: { firestore: {} },
    },
  },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_start', args);
  },
} satisfies MethodRecord;
