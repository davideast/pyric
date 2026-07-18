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
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
      .end('content-type must be application/json');
    return;
  }
  if (!hasTrustedOrigin(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('cross-origin activity reports are not allowed');
    return;
  }
  if (req.headers['x-pyric-activity-token'] !== activityToken) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('invalid activity capability');
    return;
  }
  try {
    const body = await collectActivityBody(req);
    if (!isActivityIncident(body)) throw new Error('invalid activity incident');
    onIncident(body);
    res.writeHead(204).end();
  } catch (error) {
    res.writeHead(error instanceof ActivityBodyTooLargeError ? 413 : 400, {
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end(error instanceof Error ? error.message : String(error));
  }
}

function hasTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
    return parsed.protocol === protocol && parsed.host === host;
  } catch {
    return false;
  }
}

async function collectActivityBody(req: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACTIVITY_BODY_BYTES) {
    req.resume();
    throw new ActivityBodyTooLargeError('activity incident exceeds 32 KiB');
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      if (size > MAX_ACTIVITY_BODY_BYTES) {
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
  if (!value || typeof value !== 'object') return false;
  const incident = value as Record<string, unknown>;
  const usage = incident.usage as Record<string, unknown> | undefined;
  const actor = incident.actor as Record<string, unknown> | undefined;
  const authLens = incident.authLens as Record<string, unknown> | undefined;
  const listenerBalance = incident.listenerBalance as Record<string, unknown> | undefined;
  return typeof incident.fingerprint === 'string'
    && incident.fingerprint.length <= 2_000
    && (incident.pattern === 'repeated-read'
      || incident.pattern === 'duplicate-listener'
      || incident.pattern === 'listener-churn')
    && (incident.confidence === 'medium' || incident.confidence === 'high')
    && (incident.severity === 'warning' || incident.severity === 'critical')
    && incident.service === 'firestore'
    && (incident.method === 'get' || incident.method === 'list' || incident.method === 'listen')
    && typeof incident.targetFingerprint === 'string'
    && incident.targetFingerprint.length <= 2_000
    && actor?.kind === 'app'
    && Boolean(authLens)
    && (authLens!.mode === 'app-session'
      || authLens!.mode === 'anon'
      || (authLens!.mode === 'as' && typeof authLens!.uid === 'string'))
    && (incident.authUid === null || typeof incident.authUid === 'string')
    && isNonNegativeInteger(incident.count)
    && incident.count > 0
    && isNonNegativeInteger(incident.windowMs)
    && Array.isArray(incident.evidenceEventIds)
    && incident.evidenceEventIds.length <= 8
    && incident.evidenceEventIds.every((id) => typeof id === 'string')
    && Boolean(usage)
    && (usage!.unit === 'document-reads' || usage!.unit === 'listener-attaches')
    && isNonNegativeInteger(usage!.lowerBound)
    && usage!.lowerBound === incident.count
    && Array.isArray(usage!.limitations)
    && usage!.limitations.length <= 8
    && usage!.limitations.every(
      (limitation) => typeof limitation === 'string' && limitation.length <= 500,
    )
    && (incident.sourceAttribution === 'app'
      || (typeof incident.sourceAttribution === 'string'
        && /^app [\w.-]{1,64}$/.test(incident.sourceAttribution)))
    && (listenerBalance === undefined
      || (isNonNegativeInteger(listenerBalance.attaches)
        && isNonNegativeInteger(listenerBalance.detaches)
        && isNonNegativeInteger(listenerBalance.active)
        && (listenerBalance.isLowerBound === undefined
          || typeof listenerBalance.isLowerBound === 'boolean')))
    && (incident.pattern === 'repeated-read'
      ? ((incident.method === 'get' || incident.method === 'list')
        && usage!.unit === 'document-reads'
        && listenerBalance === undefined)
      : (incident.method === 'listen'
        && usage!.unit === 'listener-attaches'
        && listenerBalance !== undefined))
    && hasGeneratedActivitySemantics(incident as unknown as ActivityIncident);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
