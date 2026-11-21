/**
 * SharedWorker and `HostedRuntime` Crashlytics subsystem: routes the 10 shared
 * `crashlytics.*` `worker-op` methods onto the per-sandbox `CrashlyticsBroker`
 * so Web (`firebase/crashlytics`), Android (`com.google.firebase.crashlytics`),
 * iOS (`FirebaseCrashlytics`), and Flutter (`firebase_crashlytics`) clients
 * share one authoritative sandbox state.
 */
import {
  getCrashlyticsBroker,
  type CrashlyticsBroker,
} from 'pyric/crashlytics/internal';
import {
  bestEffortFlush,
  fail,
  ok,
  type HostCtx,
  type PortLike,
} from './host-context.js';
import type { OpMessage } from './protocol.js';

const CRASHLYTICS_METHODS = new Set<string>([
  'crashlytics.recordError',
  'crashlytics.log',
  'crashlytics.flush',
  'crashlytics.setUserId',
  'crashlytics.setCustomKeys',
  'crashlytics.setCollectionEnabled',
  'crashlytics.checkForUnsentReports',
  'crashlytics.sendUnsentReports',
  'crashlytics.deleteUnsentReports',
  'crashlytics.getState',
]);

/** Routing predicate used by `dispatchMessage` in `host/dispatch.ts`. */
export function isCrashlyticsOp(method: string): boolean {
  return CRASHLYTICS_METHODS.has(method);
}

function broker(ctx: HostCtx): CrashlyticsBroker {
  return getCrashlyticsBroker(ctx.sandbox);
}

export async function handleCrashlyticsOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  switch (msg.method) {
    case 'crashlytics.recordError': {
      try {
        const result = broker(ctx).recordError({
          appId: msg.appId,
          name: msg.name,
          message: msg.message,
          stack: msg.stack,
          code: msg.code,
          cause: msg.cause,
          fatal: msg.fatal,
          attributes: msg.attributes,
          breadcrumbs: msg.breadcrumbs,
          timestampMs: msg.timestampMs,
          appVersion: msg.appVersion,
          region: msg.region,
          sdkPlatform: msg.sdkPlatform,
          deferred: msg.deferred,
        });
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.log': {
      try {
        const result = broker(ctx).log({
          appId: msg.appId,
          message: msg.message,
          attributes: msg.attributes,
          timestampMs: msg.timestampMs,
        });
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.flush': {
      try {
        const result = broker(ctx).flush(msg.appId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.setUserId': {
      try {
        const result = broker(ctx).setUserId(msg.appId, msg.userId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.setCustomKeys': {
      try {
        const result = broker(ctx).setCustomKeys(msg.appId, msg.keys);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.setCollectionEnabled': {
      try {
        const enabled = msg.enabled === undefined ? null : msg.enabled;
        const result = broker(ctx).setCollectionEnabled(msg.appId, enabled);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.checkForUnsentReports': {
      try {
        ok(port, msg.id, broker(ctx).checkForUnsentReports(msg.appId));
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.sendUnsentReports': {
      try {
        const result = broker(ctx).sendUnsentReports(msg.appId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.deleteUnsentReports': {
      try {
        const result = broker(ctx).deleteUnsentReports(msg.appId);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, result);
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    case 'crashlytics.getState': {
      try {
        ok(port, msg.id, broker(ctx).getState(msg.appId));
      } catch (error) {
        fail(port, msg.id, error);
      }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown Crashlytics method: ${String((msg as { method?: unknown }).method)}`));
      break;
    }
  }
}
