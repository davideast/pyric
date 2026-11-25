import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose } from '../bridge/server/peer.js';
import {
  effectiveRequestScheme,
  isAdmittedPeer,
  isLoopbackHostHeader,
  parseAllowPeersSetting,
  parseTrustProxySetting,
  type RemoteAccessOptions,
  type TrustProxyPolicy,
} from './guard-policy.js';
import {
  getHeader,
  isAllowedHost,
  isAllowedSessionToken,
  isLocalPeer,
  timingSafeTokenMatch,
} from './loopback-guard.js';
import {
  hasGeneratedActivitySemantics,
  type ActivityIncident,
} from 'pyric/firestore/internal';

export interface ActivityGuardOptions {
  boundHost?: string;
  allowedHosts?: readonly string[];
  sessionToken?: string;
  remoteAccess?: RemoteAccessOptions;
}

const MAX_ACTIVITY_BODY_BYTES = 32 * 1024;
const MAX_DEDUPED_INCIDENT_KEYS = 256;
const deliveredBySink = new WeakMap<(incident: ActivityIncident) => void, Set<string>>();

class ActivityBodyTooLargeError extends Error {}

function incidentDeliveryKey(incident: ActivityIncident): string {
  if (incident.evidenceEventIds.length > 0) {
    return `${incident.pattern}|${incident.severity}|${incident.evidenceEventIds.join(',')}`;
  }
  return `${incident.pattern}|${incident.severity}|${incident.fingerprint}|${incident.count}`;
}

function recordIncidentOnce(
  onIncident: (incident: ActivityIncident) => void,
  incident: ActivityIncident,
): boolean {
  let seen = deliveredBySink.get(onIncident);
  if (seen === undefined) {
    seen = new Set<string>();
    deliveredBySink.set(onIncident, seen);
  }
  const key = incidentDeliveryKey(incident);
  if (seen.has(key)) {
    seen.delete(key);
    seen.add(key);
    return false;
  }
  if (seen.size >= MAX_DEDUPED_INCIDENT_KEYS) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
  seen.add(key);
  return true;
}

export async function handleActivity(
  onIncident: (incident: ActivityIncident) => void,
  req: IncomingMessage,
  res: ServerResponse,
  activityToken: string,
  guard?: ActivityGuardOptions,
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
  const allowPeers = parseAllowPeersSetting(guard?.remoteAccess?.allowPeers);
  const trustProxy = parseTrustProxySetting(guard?.remoteAccess?.trustProxy);
  const localPeer = isLocalPeer(req);
  if (!localPeer && !isAdmittedPeer(req, { allowPeers })) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('cross-origin activity reports are not allowed');
    return;
  }
  const hostHeader = req.headers.host;
  const boundHost = guard?.boundHost ?? 'localhost';
  const extraHosts = resolveActivityAllowedHosts(guard);
  const isRemoteHost = !isLoopbackHostHeader(hostHeader);
  const isRemoteRequest = !localPeer || isRemoteHost;
  if (guard !== undefined && !isAllowedHost(hostHeader, boundHost, extraHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('cross-origin activity reports are not allowed');
    return;
  }
  if (!hasTrustedOrigin(req, trustProxy)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('cross-origin activity reports are not allowed');
    return;
  }
  if (isRemoteRequest && guard?.sessionToken !== undefined) {
    if (!isAllowedSessionToken(req, undefined, guard.sessionToken)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        .end('session unlock required for remote activity reports');
      return;
    }
  }
  if (!timingSafeTokenMatch(getHeader(req, 'x-pyric-activity-token'), activityToken)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      .end('invalid activity capability');
    return;
  }
  try {
    const body = await collectActivityBody(req);
    if (!isActivityIncident(body)) throw new Error('invalid activity incident');
    if (recordIncidentOnce(onIncident, body)) {
      onIncident(body);
    }
    res.writeHead(204).end();
  } catch (error) {
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ActivityBodyTooLargeError) {
      answerAndClose(req, res, 413, headers, message);
      return;
    }
    res.writeHead(400, headers).end(message);
  }
}

function resolveActivityAllowedHosts(guard: ActivityGuardOptions | undefined): readonly string[] {
  if (guard === undefined) return [];
  const merged: string[] = [];
  for (const host of guard.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  for (const host of guard.remoteAccess?.allowedHosts ?? []) {
    if (!merged.includes(host)) merged.push(host);
  }
  return merged;
}

function hasTrustedOrigin(req: IncomingMessage, trustProxy: TrustProxyPolicy): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const protocol = effectiveRequestScheme(req, trustProxy) ?? 'http:';
    return parsed.protocol === protocol && parsed.host.toLowerCase() === host.trim().toLowerCase();
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
  if (!authLens || !usage) return false;

  const hasValidAuthLens = authLens.mode === 'app-session'
    || authLens.mode === 'anon'
    || (authLens.mode === 'as' && typeof authLens.uid === 'string');
  const hasValidSourceAttribution = incident.sourceAttribution === 'app'
    || (typeof incident.sourceAttribution === 'string'
      && /^app [\w.-]{1,64}$/.test(incident.sourceAttribution));
  const hasValidListenerBalance = listenerBalance === undefined
    || (isNonNegativeInteger(listenerBalance.attaches)
      && isNonNegativeInteger(listenerBalance.detaches)
      && isNonNegativeInteger(listenerBalance.active)
      && (listenerBalance.isLowerBound === undefined
        || typeof listenerBalance.isLowerBound === 'boolean'));

  let matchesPatternShape = false;
  if (incident.pattern === 'repeated-read') {
    matchesPatternShape = (incident.method === 'get' || incident.method === 'list')
      && usage.unit === 'document-reads'
      && listenerBalance === undefined;
  } else if (incident.pattern === 'duplicate-listener' || incident.pattern === 'listener-churn') {
    matchesPatternShape = incident.method === 'listen'
      && usage.unit === 'listener-attaches'
      && listenerBalance !== undefined;
  }

  return typeof incident.fingerprint === 'string'
    && incident.fingerprint.length <= 2_000
    && (incident.confidence === 'medium' || incident.confidence === 'high')
    && (incident.severity === 'warning' || incident.severity === 'critical')
    && incident.service === 'firestore'
    && (incident.method === 'get' || incident.method === 'list' || incident.method === 'listen')
    && typeof incident.targetFingerprint === 'string'
    && incident.targetFingerprint.length <= 2_000
    && actor?.kind === 'app'
    && hasValidAuthLens
    && (incident.authUid === null || typeof incident.authUid === 'string')
    && isNonNegativeInteger(incident.count)
    && incident.count > 0
    && isNonNegativeInteger(incident.windowMs)
    && Array.isArray(incident.evidenceEventIds)
    && incident.evidenceEventIds.length <= 8
    && incident.evidenceEventIds.every((id) => typeof id === 'string')
    && (usage.unit === 'document-reads' || usage.unit === 'listener-attaches')
    && isNonNegativeInteger(usage.lowerBound)
    && usage.lowerBound === incident.count
    && Array.isArray(usage.limitations)
    && usage.limitations.length <= 8
    && usage.limitations.every(
      (limitation) => typeof limitation === 'string' && limitation.length <= 500,
    )
    && hasValidSourceAttribution
    && hasValidListenerBalance
    && matchesPatternShape
    && hasGeneratedActivitySemantics(incident as unknown as ActivityIncident);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
