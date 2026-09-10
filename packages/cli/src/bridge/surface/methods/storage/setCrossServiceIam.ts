/** Move the sandbox between the two cross-service IAM postures a project can be in. */
import { z } from 'zod';
import { replaceCrossServiceIam } from 'pyric/storage/internal';
import { CROSS_SERVICE_IAM_MODES, RENAMES } from '../../arguments/storage.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'setCrossServiceIam',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'setCrossServiceIam(mode: granted|denied)',
  description:
    "Decide whether storage rules may read Firestore through firestore.get and exists. 'denied' is the project state without roles/firebaserules.firestoreServiceAgent, where every executed lookup fails and its rule denies.",
  args: z.object({
    mode: z
      .enum(CROSS_SERVICE_IAM_MODES)
      .describe(
        "'granted' serves lookups from this sandbox's Firestore store; 'denied' fails every executed lookup.",
      ),
  }),
  operation: 'set_storage_cross_service_iam',
  renames: RENAMES,
  example: { mode: 'denied' },
  async handler(args, ctx) {
    const mode = args.mode as (typeof CROSS_SERVICE_IAM_MODES)[number];
    await replaceCrossServiceIam(ctx.sandbox, mode);
    return {
      ok: true,
      summary: `Cross-service Firestore access from storage rules is now ${mode}.`,
      data: { mode },
    };
  },
} satisfies MethodRecord;
