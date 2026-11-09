/**
 * The live host's observed session data routes, mounted by `bridge-mount.ts`
 * behind its local-peer and control guards:
 *
 * - `GET /__pyric/live/session-data` answers the in-memory snapshot
 *   (`observed-session/store.ts`) Studio and `pyric sandbox seed-from-live`
 *   read. It never touches disk.
 * - `POST /__pyric/live/seed-sandbox` writes that snapshot into the local
 *   hosted sandbox, only with `{ confirm: true }` in the body, and only for the
 *   host instance and project the caller discovered.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose, collectBody, isBodyTooLarge } from '../bridge/server/peer.js';
import { HOSTED_METHOD_BODY_LIMIT } from './hosted/method-protocol.js';
import type { ObservedSeedResult } from './hosted/seed-from-observed-session.js';
import type { ObservedSessionDataStore } from './observed-session/store.js';
import {
  LIVE_SEED_SANDBOX_PATH,
  LIVE_SESSION_DATA_PATH,
  type LiveSeedMode,
  type LiveSeedSandboxResult,
  type ObservedSessionDataSnapshot,
} from './observed-session/wire.js';

/** Whether `pathname` targets one of the live observed-session HTTP routes. */
export function isLiveSessionRoute(pathname: string): boolean {
  return pathname === LIVE_SESSION_DATA_PATH || pathname === LIVE_SEED_SANDBOX_PATH;
}

/** The hosted runtime's seeding, as the seed route calls it. */
export interface ObservedSessionSeeder {
  seedFromObservedSession(
    snapshot: ObservedSessionDataSnapshot,
    options: { mode?: LiveSeedMode; callerProjectDir?: string },
  ): Promise<ObservedSeedResult>;
}

export interface LiveSessionRouteContext {
  /** The live host's store, or undefined when this server is not a live host. */
  readonly sessionData: ObservedSessionDataStore | undefined;
  /** The running hosted runtime, or undefined before it starts. */
  readonly runtime: ObservedSessionSeeder | undefined;
  /** This host's instance id, which a seed request must name when it names one. */
  readonly instanceId: string;
}

/** A seed request's checked body, or the status and body that refuse it. */
type SeedRequest =
  | { readonly ok: true; readonly mode?: LiveSeedMode; readonly projectDir?: string }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const NO_STORE_JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

function answer(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = JSON_HEADERS): true {
  res.writeHead(status, headers).end(JSON.stringify(body));
  return true;
}

function refusal(status: number, error: string, code?: string): SeedRequest {
  const body: Record<string, unknown> = { ok: false, error };
  if (code !== undefined) body.code = code;
  return { ok: false, status, body };
}

function readSeedRequest(parsed: unknown, instanceId: string): SeedRequest {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refusal(400, 'Expected JSON object body.');
  }
  const body = parsed as { confirm?: unknown; mode?: unknown; instanceId?: unknown; projectDir?: unknown };
  if (body.confirm !== true) {
    return refusal(
      400,
      'Seeding the local sandbox from observed live session data requires explicit confirmation ({ confirm: true }).',
      'PYRIC_SEED_CONFIRM_REQUIRED',
    );
  }
  const hasMode = body.mode !== undefined;
  if (hasMode && body.mode !== 'merge' && body.mode !== 'replace') {
    return refusal(400, "Invalid mode: expected 'merge' or 'replace'.");
  }
  if (body.instanceId !== undefined && typeof body.instanceId !== 'string') {
    return refusal(400, 'Invalid instanceId: expected string.');
  }
  if (body.instanceId !== undefined && body.instanceId !== instanceId) {
    return refusal(409, 'The discovered host instance has changed.');
  }
  if (body.projectDir !== undefined && typeof body.projectDir !== 'string') {
    return refusal(400, 'Invalid projectDir: expected string.');
  }
  return { ok: true, mode: body.mode as LiveSeedMode | undefined, projectDir: body.projectDir as string | undefined };
}

export function serveLiveSessionData(req: IncomingMessage, res: ServerResponse, context: LiveSessionRouteContext): true {
  if (context.sessionData === undefined) {
    return answer(res, 404, { error: 'Observed session data is available in Live mode only.' });
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' }).end();
    return true;
  }
  return answer(res, 200, context.sessionData.snapshot(), NO_STORE_JSON_HEADERS);
}

export async function serveLiveSeedSandbox(
  req: IncomingMessage,
  res: ServerResponse,
  context: LiveSessionRouteContext,
): Promise<true> {
  const { sessionData, runtime } = context;
  if (sessionData === undefined || runtime === undefined) {
    return answer(res, 404, { ok: false, error: 'Live sandbox seeding requires a running Live mode host.' });
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return true;
  }
  try {
    const request = readSeedRequest((await collectBody(req, HOSTED_METHOD_BODY_LIMIT)) ?? {}, context.instanceId);
    if (!request.ok) return answer(res, request.status, request.body);
    const snapshot = sessionData.snapshot();
    const seeded = await runtime.seedFromObservedSession(snapshot, { mode: request.mode, callerProjectDir: request.projectDir });
    const result: LiveSeedSandboxResult = { ok: true, ...seeded, revision: snapshot.revision };
    return answer(res, 200, result, NO_STORE_JSON_HEADERS);
  } catch (error) {
    const payload = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    if (isBodyTooLarge(error)) {
      answerAndClose(req, res, 413, JSON_HEADERS, payload);
      return true;
    }
    res.writeHead(400, JSON_HEADERS).end(payload);
    return true;
  }
}

export function serveLiveSessionRoute(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  context: LiveSessionRouteContext,
): true | Promise<true> {
  if (pathname === LIVE_SESSION_DATA_PATH) {
    return serveLiveSessionData(req, res, context);
  }
  return serveLiveSeedSandbox(req, res, context);
}
