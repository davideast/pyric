/**
 * What the conformance registry claims about one feature.
 *
 * The answer is the generated projection `pyric can-i-use` prints and the
 * `pyric_can_i_use` tool returns, read here rather than restated, so the three
 * surfaces cannot disagree about what pyric supports.
 */
import { z } from 'zod';

import { canIUse } from '../../../../conformance/index.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

/** The sentence one match produces, which is the registry's own where it has one. */
function summaryFor(result: ReturnType<typeof canIUse>, feature: string): string {
  if (result.match === 'none') return `No conformance feature matched '${feature}'.`;
  if (result.match === 'suggestions') {
    return `No conformance feature is spelled '${feature}'. The closest are ${result.supports
      .map((support) => `${support.surface}/${support.feature}`)
      .join(', ')}.`;
  }
  if (result.match === 'ambiguous') {
    return `'${feature}' names a feature on more than one surface: ${result.supports
      .map((support) => support.surface)
      .join(', ')}.`;
  }
  return result.supports[0]!.summary;
}

export default {
  tool: 'assurance',
  method: 'canIUse',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'canIUse(feature)',
  description: 'Report the conformance claim for one feature.',
  args: z.object({
    feature: z
      .string()
      .min(1)
      .describe('The feature in developer words, such as setDoc or signInAnonymously.'),
  }),
  operation: 'check_assurance_feature',
  renames: { name: 'feature', query: 'feature' },
  example: { feature: 'setDoc' },
  async handler(args): Promise<OperationResult> {
    const feature = String(args.feature);
    const result = canIUse(feature);
    return {
      ok: result.match === 'exact',
      summary: summaryFor(result, feature),
      data: result,
    };
  },
} satisfies MethodRecord;
