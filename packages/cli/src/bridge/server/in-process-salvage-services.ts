/**
 * Validation helpers for CLI-owned `__pyric_cli_*` service entries stored in
 * `.pyric/state/in-process.json`.
 */
import { z } from 'zod';
import { isClockInstantInRange } from 'pyric/sandbox';
import { rulesSourceRejection } from 'pyric/rules/internal';

const APP_SESSION_SERVICE_KEY = '__pyric_cli_app_session';
const RULES_STATE_SERVICE_KEY = '__pyric_cli_rules_state';
const AGENT_IDENTITY_SERVICE_KEY = '__pyric_cli_agent_identity';
const CLOCK_STATE_SERVICE_KEY = '__pyric_cli_clock_state';
const AI_LOGIC_SCRIPTS_SERVICE_KEY = '__pyric_cli_ai_logic_scripts';

const cliAppSessionShape = z
  .object({
    uid: z.string().min(1),
    tenantId: z.string().nullable(),
  })
  .strict();

const persistedRulesEntryShape = z
  .object({
    active: z.string(),
    diskAtSave: z.string().nullable(),
  })
  .strict();

const cliRulesStateShape = z
  .object({
    firestore: persistedRulesEntryShape.optional(),
    storage: z
      .object({
        default: persistedRulesEntryShape.optional(),
        buckets: z.record(z.string(), persistedRulesEntryShape).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const cliNonUidIdentityShape = z
  .object({
    mode: z.enum(['admin', 'anonymous', 'default']),
  })
  .strict();

const cliUidIdentityShape = z
  .object({
    mode: z.literal('uid'),
    uid: z.string().min(1),
    tenant: z.string().min(1).optional(),
    claims: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const cliAgentIdentityShape = z.union([cliNonUidIdentityShape, cliUidIdentityShape]);

const cliClockStateShape = z
  .object({
    mode: z.enum(['wall', 'fixed', 'offset']),
    fixedAt: z.number().finite(),
    offsetMs: z.number().finite(),
  })
  .strict();

const cliScriptMatchShape = z
  .object({
    substring: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

const cliScriptResponseShape = z.union([
  z.object({ type: z.literal('text'), payload: z.string() }).strict(),
  z.object({ type: z.literal('json'), payload: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      type: z.literal('error'),
      payload: z.object({ code: z.number().finite(), message: z.string() }).strict(),
    })
    .strict(),
]);

const cliAiLogicStateShape = z
  .object({
    scripts: z.array(
      z
        .object({
          match: cliScriptMatchShape.nullable(),
          response: cliScriptResponseShape,
          consumed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export function validateCliService(
  name: string,
  data: unknown,
): { handled: boolean; hasData: boolean } {
  if (name === APP_SESSION_SERVICE_KEY) {
    if (data === null) return { handled: true, hasData: false };
    cliAppSessionShape.parse(data);
    return { handled: true, hasData: true };
  }
  if (name === RULES_STATE_SERVICE_KEY) {
    if (data === null) return { handled: true, hasData: false };
    const parsed = cliRulesStateShape.parse(data);
    if (parsed.firestore !== undefined && parsed.firestore.active !== '') {
      const rejection = rulesSourceRejection(parsed.firestore.active);
      if (rejection !== null) {
        throw new Error(`Invalid persisted Firestore rules: ${rejection.message}`);
      }
    }
    const hasFirestore = parsed.firestore !== undefined;
    const hasStorageDefault = parsed.storage?.default !== undefined;
    const hasStorageBuckets =
      parsed.storage?.buckets !== undefined && Object.keys(parsed.storage.buckets).length > 0;
    return { handled: true, hasData: hasFirestore || hasStorageDefault || hasStorageBuckets };
  }
  if (name === AGENT_IDENTITY_SERVICE_KEY) {
    if (data === null) return { handled: true, hasData: false };
    const parsed = cliAgentIdentityShape.parse(data);
    return { handled: true, hasData: parsed.mode !== 'default' };
  }
  if (name === CLOCK_STATE_SERVICE_KEY) {
    if (data === null) return { handled: true, hasData: false };
    const parsed = cliClockStateShape.parse(data);
    if (parsed.mode === 'fixed' && !isClockInstantInRange(parsed.fixedAt)) {
      throw new Error('Invalid persisted fixed clock timestamp.');
    }
    return { handled: true, hasData: parsed.mode !== 'wall' };
  }
  if (name === AI_LOGIC_SCRIPTS_SERVICE_KEY) {
    if (data === null) return { handled: true, hasData: false };
    const parsed = cliAiLogicStateShape.parse(data);
    return { handled: true, hasData: parsed.scripts.length > 0 };
  }
  return { handled: false, hasData: false };
}
