import {
  consumeAppCheckToken,
  mintAppCheckToken,
  type MintedAppCheckToken,
} from 'pyric/sandbox/internal';
import {
  bestEffortFlush,
  fail,
  hostProjectId,
  ok,
  type HostCtx,
  type PortLike,
} from '../host-context.js';
import type { AiAppCheckWire, InboundMessage, OpMessage } from '../protocol.js';
import { randomUuid } from './connection.js';

/** Standard App Check token lifetime (1 hour), matching `pyric/app-check`. */
const APP_CHECK_TTL_SECONDS = 3600;
/** Limited-use App Check token lifetime (5 minutes), matching `pyric/app-check`. */
const LIMITED_USE_TTL_SECONDS = 300;

const DEFAULT_PROJECT_ID = 'pyric-sandbox';
const DEFAULT_ANDROID_APP_ID = '1:000000000000:android:pyricsandbox';

type AppCheckOpMessage = Extract<
  OpMessage,
  { method: 'appCheck.getToken' | 'appCheck.getLimitedUseToken' | 'appCheck.consumeToken' }
>;

export function isAppCheckOp(method: OpMessage['method']): boolean {
  return (
    method === 'appCheck.getToken' ||
    method === 'appCheck.getLimitedUseToken' ||
    method === 'appCheck.consumeToken'
  );
}

function resolveProjectId(ctx: HostCtx, requested: string | undefined): string {
  if (typeof requested === 'string' && requested.length > 0) {
    return requested;
  }
  const fromHost = hostProjectId(ctx);
  if (typeof fromHost === 'string' && fromHost.length > 0) {
    return fromHost;
  }
  return DEFAULT_PROJECT_ID;
}

function resolveAppId(ctx: HostCtx, requested: string | undefined): string {
  if (typeof requested === 'string' && requested.length > 0) {
    return requested;
  }
  const fromAppOptions = ctx.appOptions?.appId;
  if (typeof fromAppOptions === 'string' && fromAppOptions.length > 0) {
    return fromAppOptions;
  }
  return DEFAULT_ANDROID_APP_ID;
}

function portTokenCache(ctx: HostCtx, port: PortLike): Map<string, MintedAppCheckToken> {
  if (ctx.appCheckTokens === undefined) {
    ctx.appCheckTokens = new WeakMap();
  }
  let cache = ctx.appCheckTokens.get(port);
  if (cache === undefined) {
    cache = new Map();
    ctx.appCheckTokens.set(port, cache);
  }
  return cache;
}

export async function handleAppCheckOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  const appCheckMsg = msg as AppCheckOpMessage;
  try {
    if (appCheckMsg.method === 'appCheck.consumeToken') {
      const outcome = consumeAppCheckToken(ctx.sandbox, appCheckMsg.tokenId);
      await bestEffortFlush(ctx, appCheckMsg.method);
      ok(port, appCheckMsg.id, outcome);
      return;
    }

    const projectId = resolveProjectId(ctx, appCheckMsg.projectId);
    const appId = resolveAppId(ctx, appCheckMsg.appId);

    if (appCheckMsg.method === 'appCheck.getLimitedUseToken') {
      const minted = await mintAppCheckToken(
        { appId, projectId, jti: randomUuid() },
        LIMITED_USE_TTL_SECONDS,
      );
      ok(port, appCheckMsg.id, {
        token: minted.token,
        expireTimeMillis: minted.expireTimeMillis,
      });
      return;
    }

    const cache = portTokenCache(ctx, port);
    const cacheKey = `${projectId}::${appId}`;
    const forceRefresh = appCheckMsg.forceRefresh === true;
    const nowMillis = Date.now();
    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expireTimeMillis > nowMillis) {
        ok(port, appCheckMsg.id, {
          token: cached.token,
          expireTimeMillis: cached.expireTimeMillis,
        });
        return;
      }
    }

    const minted = await mintAppCheckToken({ appId, projectId }, APP_CHECK_TTL_SECONDS, nowMillis);
    cache.set(cacheKey, minted);
    ok(port, appCheckMsg.id, {
      token: minted.token,
      expireTimeMillis: minted.expireTimeMillis,
    });
  } catch (error) {
    fail(port, appCheckMsg.id, error);
  }
}

export function recordPortAppCheckToken(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): void {
  const attached = msg.appCheckToken;
  if (typeof attached !== 'string' || attached.length === 0) {
    return;
  }
  if (ctx.portAppCheckTokens === undefined) {
    ctx.portAppCheckTokens = new WeakMap();
  }
  ctx.portAppCheckTokens.set(port, attached);
}

export function resolveEffectiveAiAppCheck(
  explicit: AiAppCheckWire | undefined,
  attachedToken: string | undefined,
): AiAppCheckWire | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof attachedToken === 'string' && attachedToken.length > 0) {
    return { token: attachedToken };
  }
  return undefined;
}

export function cleanupPortAppCheck(ctx: HostCtx, port: PortLike): void {
  ctx.appCheckTokens?.delete(port);
  ctx.portAppCheckTokens?.delete(port);
}
