/**
 * Record who can reach the target and what they are known to be allowed to do.
 *
 * A campaign interprets nothing until it knows which identities an attacker
 * can actually acquire and which operations were observed succeeding. Those
 * two lists are what a probe is proposed from, so they are supplied rather
 * than guessed.
 */
import { z } from 'zod';

import { authoredRecord, campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'map',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'map(campaignId, actors?, observations?, probes?)',
  description: 'Add actors, observations, and probes.',
  args: z.object({
    campaignId,
    actors: z
      .array(authoredRecord)
      .optional()
      .describe('Identities an attacker can acquire, each with how it is acquired.'),
    observations: z
      .array(authoredRecord)
      .optional()
      .describe('Operations observed succeeding, each naming its actor.'),
    probes: z
      .array(authoredRecord)
      .optional()
      .describe('Probes authored by hand rather than proposed from an observation.'),
  }),
  operation: 'map_assurance_campaign',
  renames: { identities: 'actors', cases: 'observations' },
  example: {
    campaignId: 'first-pass',
    actors: [{ id: 'anon', acquisition: { kind: 'anonymous-request' } }],
  },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_map', args);
  },
} satisfies MethodRecord;
