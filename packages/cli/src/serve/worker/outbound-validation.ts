import type { AiEvidence } from 'pyric/ai/internal';
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isClockState(value: unknown): boolean {
  const isObject = isRecord(value);
  const isInvalidObject = !isObject;
  if (isInvalidObject) return false;
  const hasKnownMode = value.mode === 'wall' || value.mode === 'fixed' || value.mode === 'offset';
  return hasKnownMode && Number.isFinite(value.fixedAt) && Number.isFinite(value.offsetMs);
}

export function hasValidReplyOutcome(reply: { ok?: unknown; error?: unknown }): boolean {
  const isSuccess = reply.ok === true;
  if (isSuccess) return true;
  const error = reply.error;
  const isErrorRecord = isRecord(error);
  return reply.ok === false && isErrorRecord && typeof error.code === 'string' && typeof error.message === 'string';
}

/** Correlation and control fields must be usable before a reply reaches its owner. */
export function hasValidOutboundEnvelope(value: unknown): boolean {
  const isObject = isRecord(value);
  const isInvalidObject = !isObject;
  if (isInvalidObject) return false;
  const hasInvalidSession = value.clientSessionId !== undefined && typeof value.clientSessionId !== 'string';
  if (hasInvalidSession) return false;
  switch (value.t) {
    case 'res': return typeof value.id === 'string';
    case 'snap': return typeof value.subId === 'string';
    case 'event': return typeof value.subId === 'string' && Array.isArray(value.events);
    case 'runtime-reload': return typeof value.epoch === 'string';
    case 'clock': return isClockState(value.state);
    default: return false;
  }
}

interface SnapshotError {
  code: string;
  message: string;
  denialContext?: unknown;
  aiEnvelope?: unknown;
  aiEvidence?: Partial<AiEvidence>;
  envelope?: unknown;
}

/** A malformed terminal delivery is itself a terminal transport error. */
export function snapshotError(frame: { value?: unknown }): SnapshotError | undefined {
  const malformed: SnapshotError = { code: 'unavailable', message: 'The sandbox sent a malformed subscription reply.' };
  const isMissingValue = !Object.hasOwn(frame, 'value');
  if (isMissingValue) return malformed;
  const value = frame.value;
  const carriesError = isRecord(value) && Object.hasOwn(value, '__error');
  const hasNoError = !carriesError;
  if (hasNoError) return;
  const error = value.__error;
  const isErrorRecord = isRecord(error);
  const isInvalidRecord = !isErrorRecord;
  if (isInvalidRecord) return malformed;
  const code = error.code;
  const message = error.message;
  const isInvalidError = typeof code !== 'string' || typeof message !== 'string';
  if (isInvalidError) return malformed;
  const evidence = error.aiEvidence;
  const hasEvidence = isRecord(evidence);
  return { code, message, denialContext: error.denialContext,
    aiEnvelope: error.aiEnvelope, aiEvidence: hasEvidence ? evidence : undefined, envelope: error.envelope };
}
