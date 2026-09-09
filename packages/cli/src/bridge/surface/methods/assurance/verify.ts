/**
 * Check a candidate ruleset against everything the campaign has established.
 *
 * A candidate passes only when it keeps every known-good control working and
 * denies every negative case the campaign demonstrated, which is the pair a
 * rules change usually gets one half of wrong.
 */
import { z } from 'zod';

import { authoredRecord, campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'verify',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'verify(campaignId, rules, includeCandidates?, verificationId?)',
  description:
    "Check candidate rules against the campaign's cases.",
  args: z.object({
    campaignId,
    rules: authoredRecord.describe('The candidate rules by service: firestore, rtdb, and storage.'),
    includeCandidates: z
      .boolean()
      .optional()
      .describe('Include probes the campaign proposed but never demonstrated.'),
    verificationId: z.string().min(1).optional().describe('A name for this verification run.'),
  }),
  operation: 'verify_assurance_rules',
  renames: { runId: 'campaignId', candidateRules: 'rules' },
  example: {
    campaignId: 'first-pass',
    rules: { firestore: "rules_version = '2';\nservice cloud.firestore {}" },
  },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_verify', args);
  },
} satisfies MethodRecord;
