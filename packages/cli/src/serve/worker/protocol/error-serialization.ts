import { getAiEvidence, type AiEvidence } from 'pyric/ai/internal';
import type { AnyDenialContext } from 'pyric/sandbox';
import type { FcmErrorEnvelope } from 'pyric/messaging/internal';
import { isPlainRecord, stripWireTokenClaims } from '../../repro/token-claims.js';

/**
 * Wire form of the Gemini error envelope an `AiBrokerError` carries.
 */
interface AiErrorEnvelopeWire {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<Record<string, unknown>>;
  };
}

export interface SerializedError {
  aiEvidence?: Partial<AiEvidence>;
  code: string;
  /** The source error had no `code`, so the page's error has none either; `code` is then `unknown`. */
  codeless?: true;
  message: string;
  /** Structured rules denial frame; `engine` tells an RTDB frame from a Firestore one. */
  denialContext?: AnyDenialContext;
  remediation?: string;
  queryProof?: unknown;
  rule?: unknown;
  request?: unknown;
  resource?: unknown;
  query?: unknown;
  aiEnvelope?: AiErrorEnvelopeWire;
  envelope?: FcmErrorEnvelope;
}

export function serializeError(err: unknown): SerializedError {
  const base = serializeErrorValue(err);
  if (err !== null && typeof err === 'object') {
    const evidence = getAiEvidence(err);
    if (evidence !== undefined) {
      return { ...base, aiEvidence: evidence };
    }
  }
  return base;
}

const FIXTURE_CASE_PREFIX = '  Fixture case: ';

function wireAuthOf(
  auth: unknown,
  options?: { promoteTenant?: boolean },
): unknown {
  if (!isPlainRecord(auth)) return auth;
  let rawToken: Record<string, unknown> | undefined;
  if (isPlainRecord(auth.token)) {
    rawToken = auth.token;
  }
  let rawFirebase: Record<string, unknown> | undefined;
  if (rawToken !== undefined && isPlainRecord(rawToken.firebase)) {
    rawFirebase = rawToken.firebase;
  }
  let promotedTenant: string | undefined;
  if (
    options?.promoteTenant !== false &&
    auth.tenant === undefined &&
    rawFirebase !== undefined &&
    typeof rawFirebase.tenant === 'string'
  ) {
    promotedTenant = rawFirebase.tenant;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(auth)) {
    if (key === 'tenant' && entry === undefined) continue;
    if (key === 'token') {
      if (promotedTenant !== undefined) {
        out.tenant = promotedTenant;
      }
      if (rawToken !== undefined) {
        const wireToken = stripWireTokenClaims(rawToken);
        if (wireToken !== undefined) {
          out.token = wireToken;
        }
      }
      continue;
    }
    out[key] = entry;
  }
  return out;
}

function wireRequestOf(request: unknown): unknown {
  if (!isPlainRecord(request)) return request;
  const { auth: _auth, ...rest } = request;
  return rest;
}

function wireReproOf(repro: unknown): unknown {
  if (!isPlainRecord(repro) || !isPlainRecord(repro.testCase)) return repro;
  const testCase: Record<string, unknown> = { ...repro.testCase };
  if ('auth' in repro.testCase) {
    testCase.auth = wireAuthOf(repro.testCase.auth, { promoteTenant: false });
  }
  return { ...repro, testCase };
}

function sanitizeWireBigInts(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = sanitizeWireBigInts(item, seen);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }
  if (!isPlainRecord(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = sanitizeWireBigInts(item, seen);
    if (next !== item) changed = true;
    Object.defineProperty(out, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return changed ? out : value;
}

function wireDenialContextOf(denialContext: Record<string, unknown>): AnyDenialContext {
  const out: Record<string, unknown> = { ...denialContext };
  if ('auth' in denialContext) out.auth = wireAuthOf(denialContext.auth);
  if ('request' in denialContext) out.request = wireRequestOf(denialContext.request);
  if ('repro' in denialContext) out.repro = wireReproOf(denialContext.repro);
  return sanitizeWireBigInts(out) as unknown as AnyDenialContext;
}

function wireRemediationOf(remediation: string): string {
  const lines = remediation.split('\n').map((line) => {
    if (!line.startsWith(FIXTURE_CASE_PREFIX)) return line;
    try {
      const parsed = JSON.parse(line.slice(FIXTURE_CASE_PREFIX.length)) as unknown;
      if (!isPlainRecord(parsed)) return line;
      const wireCase: Record<string, unknown> = { ...parsed };
      if ('auth' in parsed) {
        wireCase.auth = wireAuthOf(parsed.auth, { promoteTenant: false });
      }
      return `${FIXTURE_CASE_PREFIX}${JSON.stringify(wireCase)}`;
    } catch {
      return line;
    }
  });
  return lines.join('\n');
}

function serializeErrorValue(err: unknown): SerializedError {
  if (err !== null && typeof err === 'object') {
    const envelope = (err as { envelope?: AiErrorEnvelopeWire }).envelope;
    if (
      envelope !== null &&
      typeof envelope === 'object' &&
      typeof envelope.error?.code === 'number' &&
      typeof envelope.error?.message === 'string' &&
      typeof envelope.error?.status === 'string'
    ) {
      return {
        code: `ai/${envelope.error.status}`,
        message: envelope.error.message,
        aiEnvelope: envelope,
      };
    }
    const e = err as {
      code?: unknown;
      message?: unknown;
      denialContext?: unknown;
      remediation?: unknown;
      queryProof?: unknown;
      rule?: unknown;
      request?: unknown;
      resource?: unknown;
      query?: unknown;
    };
    const hasDenialDiagnostics =
      isPlainRecord(e.denialContext) ||
      typeof e.remediation === 'string' ||
      e.queryProof !== undefined ||
      e.rule !== undefined ||
      e.request !== undefined;
    const wireMessage = (msg: string): string => {
      if (!hasDenialDiagnostics) return msg;
      return wireRemediationOf(msg);
    };
    const extras: Partial<SerializedError> = {};
    if (isPlainRecord(e.denialContext)) extras.denialContext = wireDenialContextOf(e.denialContext);
    if (typeof e.remediation === 'string') extras.remediation = wireRemediationOf(e.remediation);
    if (e.queryProof !== undefined) extras.queryProof = sanitizeWireBigInts(e.queryProof);
    if (e.rule !== undefined) extras.rule = sanitizeWireBigInts(e.rule);
    if (e.request !== undefined) extras.request = sanitizeWireBigInts(wireRequestOf(e.request));
    if (e.resource !== undefined) extras.resource = sanitizeWireBigInts(e.resource);
    if (e.query !== undefined) extras.query = sanitizeWireBigInts(e.query);
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return { code: e.code, message: wireMessage(e.message), ...extras };
    }
    if (err instanceof Error) {
      if (e.code === undefined) {
        return { code: 'unknown', codeless: true, message: wireMessage(err.message), ...extras };
      }
      return { code: 'unknown', message: wireMessage(err.message), ...extras };
    }
  }
  return { code: 'unknown', message: String(err) };
}
