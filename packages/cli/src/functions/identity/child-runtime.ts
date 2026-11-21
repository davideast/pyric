/**
 * The v2 Identity Platform blocking trigger family inside the isolated
 * Functions child: ensures `firebase-functions` `onInit` callbacks run before
 * handler execution, registers discovered blocking triggers over the remote
 * sandbox channel, and reports each execution over IPC.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RemoteSandbox } from '../../remote/index.js';
import { serializeError, type FunctionsChildEvent } from '../child-protocol.js';
import { RemoteIdentityTriggerDelivery } from './delivery.js';
import type { IdentityExecutionResult } from './response.js';
import {
  startIdentityTriggerExecution,
  type IdentityTriggerExecutionHost,
} from './execution.js';

export interface IdentityChildRuntimeOptions {
  entry: string;
  exported: Record<string, unknown>;
  sandbox: RemoteSandbox;
  send(event: FunctionsChildEvent): void;
}

type WithInitFn = <T extends (...args: unknown[]) => unknown>(fn: T) => (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;

function createOnInitRunner(entry: string): () => Promise<void> {
  let initPromise: Promise<void> | undefined;
  return () => {
    if (initPromise !== undefined) return initPromise;
    initPromise = (async () => {
      let functionsMain: string;
      try {
        functionsMain = createRequire(entry).resolve('firebase-functions');
      } catch {
        // Synthetic test fixtures without a `firebase-functions` package install have no `onInit` state.
        return;
      }
      // `functionsMain` resolves to `<pkg>/lib/v2/index.js` in `firebase-functions@7.2.5`.
      const libDir = dirname(dirname(functionsMain));
      const cjsOnInitPath = join(libDir, 'common/onInit.js');
      if (existsSync(cjsOnInitPath)) {
        const cjsModule = createRequire(functionsMain)(cjsOnInitPath) as {
          withInit?: WithInitFn;
        };
        if (typeof cjsModule.withInit === 'function') {
          await cjsModule.withInit(() => undefined)();
        }
      }
      const esmOnInitPath = join(libDir, 'esm/common/onInit.mjs');
      if (existsSync(esmOnInitPath)) {
        const esmModule = (await import(pathToFileURL(esmOnInitPath).href)) as {
          withInit?: WithInitFn;
        };
        if (typeof esmModule.withInit === 'function') {
          await esmModule.withInit(() => undefined)();
        }
      }
    })();
    return initPromise;
  };
}

function executionEvent(
  result: IdentityExecutionResult,
  exportName: string,
  ref: string,
): FunctionsChildEvent {
  if (result.status === 'fulfilled') {
    return { type: 'execution', exportName, ref, params: {}, status: 'fulfilled' };
  }
  let errorToReport: Error;
  if (result.rawError instanceof Error) {
    errorToReport = result.rawError;
  } else {
    errorToReport = new Error(`${result.error.status}: ${result.error.message}`);
  }
  return {
    type: 'execution',
    exportName,
    ref,
    params: {},
    status: 'rejected',
    error: serializeError(errorToReport),
  };
}

/** Start serving Identity blocking triggers in the isolated Functions child. */
export function startIdentityChildRuntime(
  options: IdentityChildRuntimeOptions,
): IdentityTriggerExecutionHost {
  const { entry, exported, sandbox, send } = options;
  return startIdentityTriggerExecution({
    exported,
    delivery: new RemoteIdentityTriggerDelivery(sandbox.channel),
    ensureInitialized: createOnInitRunner(entry),
    nextEventId: (_request, sequence) => `${randomUUID()}-${sequence}`,
    onExecution(result, trigger, request) {
      let subject: string = request.eventType;
      if (typeof request.userRecord?.uid === 'string' && request.userRecord.uid.length > 0) {
        subject = `auth/users/${request.userRecord.uid}`;
      } else if (typeof request.email === 'string' && request.email.length > 0) {
        subject = `auth/email/${request.email}`;
      }
      send(executionEvent(result, trigger.exportName, subject));
    },
    onDeliveryError(error, trigger) {
      send({
        type: 'delivery-error',
        exportName: trigger.exportName,
        error: serializeError(error),
      });
    },
  });
}
