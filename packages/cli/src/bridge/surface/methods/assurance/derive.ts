/**
 * Derive tri-source assurance diagnostics and counterexample probes into a
 * fresh local campaign.
 */
import { z } from 'zod';

import { isLoopbackHost } from '../../../../assurance/attachment.js';
import { campaignId } from '../../arguments/assurance.js';
import { realProjectPathWithin } from '../../arguments/project-real-path.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import { failFor } from '../../method-validation.js';
import type { InvalidArguments, MethodRecord } from '../../method-types.js';

function hasResolvedPath(
  value: { path: string } | InvalidArguments,
): value is { path: string } {
  return Object.hasOwn(value, 'path');
}

function isValidLoopbackUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return isLoopbackHost(parsed.hostname);
}

export default {
  tool: 'assurance',
  method: 'derive',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'derive(root?, url?, campaignId?, includeStaticChecks?, includeHeuristic?)',
  description: 'Derive proofs and probes.',
  args: z.object({
    root: z
      .string()
      .min(1)
      .optional()
      .describe('Project subdirectory to scan, relative to the project root.'),
    url: z
      .string()
      .min(1)
      .optional()
      .describe('Loopback HTTP(S) URL of a live Pyric server to clone.'),
    campaignId: campaignId
      .optional()
      .describe('A name for the derived campaign. One is generated when absent.'),
    includeStaticChecks: z
      .boolean()
      .optional()
      .describe('Include static query, storage contract, index, and coverage checks. Default true.'),
    includeHeuristic: z
      .boolean()
      .optional()
      .describe('Include heuristic coverage diagnostics in the response. Default true.'),
  }),
  operation: 'derive_assurance_campaign',
  renames: { id: 'campaignId', campaign: 'campaignId' },
  example: { campaignId: 'audit-pass' },
  handler: async (args, ctx) => {
    if (args.root !== undefined) {
      const checked = realProjectPathWithin(
        ctx.projectDir,
        String(args.root),
        'root',
        failFor('assurance', 'derive'),
      );
      if (!hasResolvedPath(checked)) return checked;
    }
    if (args.url !== undefined && !isValidLoopbackUrl(String(args.url))) {
      return failFor('assurance', 'derive')(
        'url must be a credential-free HTTP(S) loopback URL.',
        'Pass a loopback URL such as http://127.0.0.1:3473 or omit url to clone the connected sandbox.',
        'url',
      );
    }
    return callAssuranceOperation(ctx, 'firebase_assurance_derive', args);
  },
} satisfies MethodRecord;
