/**
 * Worker-backed Crashlytics client transport forwarding `log`, `recordError`,
 * and `flush` calls in strict FIFO order over the app's SharedWorker /
 * `HostedRuntime` port.
 */
import type {
  CrashlyticsClientTransport,
  CrashlyticsLogInput,
  CrashlyticsRecordErrorInput,
} from 'pyric/crashlytics/internal';
import { nextId, rpc } from './core.js';
import type { ClientDb } from './handles.js';

export function createWorkerCrashlyticsTransport(
  db: ClientDb,
  appId: string,
): CrashlyticsClientTransport {
  return {
    async log(input: CrashlyticsLogInput): Promise<void> {
      await rpc(db.port, {
        t: 'op',
        id: nextId(),
        method: 'crashlytics.log',
        appId,
        message: input.message,
        attributes: input.attributes,
        timestampMs: input.timestampMs,
      });
    },

    async recordError(input: CrashlyticsRecordErrorInput): Promise<void> {
      await rpc(db.port, {
        t: 'op',
        id: nextId(),
        method: 'crashlytics.recordError',
        appId,
        name: input.name,
        message: input.message,
        stack: input.stack,
        code: input.code,
        cause: input.cause,
        fatal: input.fatal,
        attributes: input.attributes,
        breadcrumbs: input.breadcrumbs,
        timestampMs: input.timestampMs,
        appVersion: input.appVersion,
        region: input.region,
        sdkPlatform: input.sdkPlatform,
        deferred: input.deferred,
      });
    },

    async flush(): Promise<void> {
      await rpc(db.port, {
        t: 'op',
        id: nextId(),
        method: 'crashlytics.flush',
        appId,
      });
    },
  };
}
