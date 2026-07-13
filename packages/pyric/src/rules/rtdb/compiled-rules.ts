import { RtdbMapper } from './mapper.js';
import { SimulateHandler } from './simulation/handler.js';
import type {
  SimulationInput,
  SimulateResult,
} from './simulation/spec.js';
import type { RtdbIR, RtdbNode } from './types.js';

const LEGACY_INTERNAL_DATABASE_URL = 'https://local-rtdb.firebaseio.com';

/** The environment-independent tree produced from an RTDB rules document. */
export type CompiledRtdbRules = RtdbNode;

export function compileRtdbRules(rulesJson: unknown): CompiledRtdbRules {
  return RtdbMapper.mapToIR(
    rulesJson,
    null,
    LEGACY_INTERNAL_DATABASE_URL,
  ).rules as RtdbNode;
}

export function serializeRtdbRules(
  compiled: CompiledRtdbRules,
): { rules: Record<string, unknown> } {
  const legacyIr: RtdbIR = {
    service: 'realtime-database',
    databaseUrl: LEGACY_INTERNAL_DATABASE_URL,
    rules: compiled,
  };
  return RtdbMapper.mapToRulesJSON(legacyIr);
}

export function simulateRtdbRules(
  compiled: CompiledRtdbRules,
  input: SimulationInput,
): SimulateResult {
  const legacyIr: RtdbIR = {
    service: 'realtime-database',
    databaseUrl: LEGACY_INTERNAL_DATABASE_URL,
    rules: compiled,
  };
  return new SimulateHandler().execute(legacyIr, input);
}
