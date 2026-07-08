import type { RtdbRulesDocument } from 'pyric/rules/rtdb';

export interface RtdbRulesJson {
  rules: Record<string, unknown>;
}

export function isRtdbRulesJson(value: unknown): value is RtdbRulesJson {
  return isRtdbRulesObject(value) && isRtdbRulesObject(value.rules);
}

export function parseRtdbRulesJson(
  value: unknown,
  onInvalid: () => Error,
): RtdbRulesJson {
  if (!isRtdbRulesJson(value)) throw onInvalid();
  return value;
}

export function isRtdbRulesDocument(value: unknown): value is RtdbRulesDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function isRtdbRulesObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
