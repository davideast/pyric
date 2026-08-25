import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hasGeneratedActivitySemantics,
  type ActivityIncident,
} from 'pyric/firestore/internal';

const MAX_ACTIVITY_BODY_BYTES = 32 * 1024;

class ActivityBodyTooLargeError extends Error {}

export async function handleActivity(
  onIncident: (incident: ActivityIncident) => void,
  req: IncomingMessage,
  res: ServerResponse,
  activityToken: string,
): Promise<void> {
  const isPostMethod = req.method === 'POST';
  if (!isPostMethod) {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  const isJsonMediaType = mediaType === 'application/json';
  if (!isJsonMediaType) {
    res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
      .end('content-type must be application/json');
    return;
  }
  const isOriginTrusted = hasTrustedOrigin(req);
  if (!isOriginTrusted) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('cross-origin activity reports are not allowed');
    return;
  }
  const isTokenValid = req.headers['x-pyric-activity-token'] === activityToken;
  if (!isTokenValid) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('invalid activity capability');
    return;
  }
  try {
    const body = await collectActivityBody(req);
    const isValidIncident = isActivityIncident(body);
    if (!isValidIncident) throw new Error('invalid activity incident');
    onIncident(body);
    res.writeHead(204).end();
  } catch (error) {
    const isBodyTooLarge = error instanceof ActivityBodyTooLargeError;
    res.writeHead(isBodyTooLarge ? 413 : 400, {
      'content-type': 'text/plain; charset=utf-8',
    });
    const isErrorInstance = error instanceof Error;
    res.end(isErrorInstance ? error.message : String(error));
  }
}

function hasTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const isOriginMissing = origin === undefined;
  if (isOriginMissing) return false;
  const host = req.headers.host;
  const isHostMissing = !host;
  if (isHostMissing) return false;
  try {
    const parsed = new URL(origin);
    const isEncrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const protocol = isEncrypted ? 'https:' : 'http:';
    const isProtocolMatch = parsed.protocol === protocol;
    const isHostMatch = parsed.host === host;
    return isProtocolMatch && isHostMatch;
  } catch {
    return false;
  }
}

async function collectActivityBody(req: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length']);
  const isLengthFinite = Number.isFinite(declaredLength);
  const isExceedingMax = declaredLength > MAX_ACTIVITY_BODY_BYTES;
  const isDeclaredTooLarge = isLengthFinite && isExceedingMax;
  if (isDeclaredTooLarge) {
    req.resume();
    throw new ActivityBodyTooLargeError('activity incident exceeds 32 KiB');
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const isStringChunk = typeof chunk === 'string';
      const bytes = isStringChunk ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      const isSizeTooLarge = size > MAX_ACTIVITY_BODY_BYTES;
      if (isSizeTooLarge) {
        settled = true;
        chunks.length = 0;
        reject(new ActivityBodyTooLargeError('activity incident exceeds 32 KiB'));
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function isActivityIncident(value: unknown): value is ActivityIncident {
  const isObjectValue = Boolean(value) && typeof value === 'object';
  if (!isObjectValue) return false;
  const incident = value as Record<string, unknown>;
  const usage = incident.usage as Record<string, unknown> | undefined;
  const actor = incident.actor as Record<string, unknown> | undefined;
  const authLens = incident.authLens as Record<string, unknown> | undefined;
  const listenerBalance = incident.listenerBalance as Record<string, unknown> | undefined;

  const isFingerprintValid = typeof incident.fingerprint === 'string' && incident.fingerprint.length <= 2_000;
  const isPatternValid = incident.pattern === 'repeated-read'
    || incident.pattern === 'duplicate-listener'
    || incident.pattern === 'listener-churn';
  const isConfidenceValid = incident.confidence === 'medium' || incident.confidence === 'high';
  const isSeverityValid = incident.severity === 'warning' || incident.severity === 'critical';
  const isServiceValid = incident.service === 'firestore';
  const isMethodValid = incident.method === 'get' || incident.method === 'list' || incident.method === 'listen';
  const isTargetFingerprintValid = typeof incident.targetFingerprint === 'string' && incident.targetFingerprint.length <= 2_000;
  const isActorValid = actor?.kind === 'app';
  const hasAuthLens = Boolean(authLens);
  const isAuthModeValid = hasAuthLens && (authLens!.mode === 'app-session'
    || authLens!.mode === 'anon'
    || (authLens!.mode === 'as' && typeof authLens!.uid === 'string'));
  const isAuthUidValid = incident.authUid === null || typeof incident.authUid === 'string';
  const isCountValid = isNonNegativeInteger(incident.count) && incident.count > 0;
  const isWindowMsValid = isNonNegativeInteger(incident.windowMs);
  const isEvidenceIdsValid = Array.isArray(incident.evidenceEventIds)
    && incident.evidenceEventIds.length <= 8
    && incident.evidenceEventIds.every((id) => typeof id === 'string');
  const hasUsage = Boolean(usage);
  const isUsageUnitValid = hasUsage && (usage!.unit === 'document-reads' || usage!.unit === 'listener-attaches');
  const isUsageLowerBoundValid = hasUsage && isNonNegativeInteger(usage!.lowerBound) && usage!.lowerBound === incident.count;
  const isUsageLimitationsValid = hasUsage
    && Array.isArray(usage!.limitations)
    && usage!.limitations.length <= 8
    && usage!.limitations.every(
      (limitation) => typeof limitation === 'string' && limitation.length <= 500,
    );
  const isSourceAttributionValid = incident.sourceAttribution === 'app'
    || (typeof incident.sourceAttribution === 'string'
      && /^app [\w.-]{1,64}$/.test(incident.sourceAttribution));
  const isListenerBalanceValid = listenerBalance === undefined
    || (isNonNegativeInteger(listenerBalance.attaches)
      && isNonNegativeInteger(listenerBalance.detaches)
      && isNonNegativeInteger(listenerBalance.active)
      && (listenerBalance.isLowerBound === undefined
        || typeof listenerBalance.isLowerBound === 'boolean'));
  const isPatternStructureValid = incident.pattern === 'repeated-read'
    ? ((incident.method === 'get' || incident.method === 'list')
      && usage!.unit === 'document-reads'
      && listenerBalance === undefined)
    : (incident.method === 'listen'
      && usage!.unit === 'listener-attaches'
      && listenerBalance !== undefined);
  const hasSemantics = hasGeneratedActivitySemantics(incident as unknown as ActivityIncident);

  return isFingerprintValid
    && isPatternValid
    && isConfidenceValid
    && isSeverityValid
    && isServiceValid
    && isMethodValid
    && isTargetFingerprintValid
    && isActorValid
    && isAuthModeValid
    && isAuthUidValid
    && isCountValid
    && isWindowMsValid
    && isEvidenceIdsValid
    && isUsageUnitValid
    && isUsageLowerBoundValid
    && isUsageLimitationsValid
    && isSourceAttributionValid
    && isListenerBalanceValid
    && isPatternStructureValid
    && hasSemantics;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
