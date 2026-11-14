/**
 * Stream wrappers (`File.createWriteStream` and `File.createReadStream`) for
 * `@google-cloud/storage` under `@pyric/live/register`.
 *
 * Extracted from `storage.ts` so both modules stay concise and under the
 * 600-line ceiling while marking stream methods with `ADMIN_METHOD_GATED`.
 */
import { PassThrough, type Readable, Writable } from 'node:stream';
import type { LiveCallRecord, LiveObserver } from '../observe.js';
import { attachSessionData, type ObservedSessionDelta } from '../session-data.js';
import {
  isObservingAdminCall,
  keepShape,
  markAdminMethodGated,
  runInsideAdminCall,
  type AdminRow,
} from './patch.js';
import {
  captureAdminWriteStreamDelta,
  extractAdminWriteOptionsMetadata,
  numericByteLengthOf,
} from './storage-session-capture.js';

const WRITE_STREAM_PATCHED = Symbol.for('pyric.live.admin.storage.writeStream');
const READ_STREAM_PATCHED = Symbol.for('pyric.live.admin.storage.readStream');

const STANDARD_WRITABLE_EVENTS: ReadonlySet<string | symbol> = new Set([
  'close',
  'drain',
  'error',
  'finish',
  'newListener',
  'pipe',
  'prefinish',
  'removeListener',
  'unpipe',
]);

export interface StorageStreamBase {
  projectId?: string;
  bucket?: string;
  path?: string;
}

export interface StorageStreamHelpers {
  readonly moduleName: string;
  readonly baseOf: (methodName: string, args: readonly unknown[], self: unknown) => StorageStreamBase;
  readonly codeOf: (error: unknown) => string;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function emitStreamRecord(
  observer: LiveObserver,
  moduleName: string,
  name: 'File.createWriteStream' | 'File.createReadStream',
  base: StorageStreamBase,
  outcome: 'resolved' | 'rejected',
  usage: { uploadedBytes: number } | { downloadedBytes: number } | undefined,
  sessionData: ObservedSessionDelta | undefined,
  codeOf: (error: unknown) => string,
  error?: unknown,
): void {
  const record: {
    module: string;
    sdk: 'admin';
    name: string;
    outcome: 'resolved' | 'rejected';
    projectId?: string;
    bucket?: string;
    path?: string;
    code?: string;
    usage?: { uploadedBytes?: number; downloadedBytes?: number };
  } = {
    module: moduleName,
    sdk: 'admin',
    name,
    outcome,
  };
  if (base.projectId !== undefined) record.projectId = base.projectId;
  if (base.bucket !== undefined) record.bucket = base.bucket;
  if (base.path !== undefined) record.path = base.path;
  if (outcome === 'resolved') {
    if (usage !== undefined) record.usage = usage;
  } else {
    record.code = codeOf(error);
  }
  const finalized = record as LiveCallRecord;
  if (outcome === 'resolved') {
    attachSessionData(finalized, sessionData);
  }
  try {
    observer(finalized);
  } catch {
    // Observer failures never alter stream settlement.
  }
}

/** Patches `File.prototype.createWriteStream` once with project/bucket gating and byte/session capture. */
export function patchCreateWriteStream(
  prototype: object | undefined,
  adminRow: AdminRow,
  helpers: StorageStreamHelpers,
): void {
  if (prototype === undefined || Object.hasOwn(prototype, WRITE_STREAM_PATCHED)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createWriteStream');
  const real = descriptor?.value as unknown;
  if (typeof real !== 'function') return;
  const realFn = real as (this: unknown, ...args: unknown[]) => Writable;

  const wrapped = keepShape(function adminCreateWriteStream(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) {
      return Reflect.apply(realFn, this, args);
    }
    const self = this;
    const base = helpers.baseOf('createWriteStream', args, self);
    const optionsMeta = extractAdminWriteOptionsMetadata(args[0]);

    let writtenBytes = 0;
    let reachedSdk = false;
    let settled = false;
    let underlying: Writable | undefined;
    const wantedCustomEvents = new Set<string | symbol>(['response']);
    const bridgedCustomEvents = new Set<string | symbol>();

    const recordOnce = (outcome: 'resolved' | 'rejected', error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (outcome === 'rejected' && !reachedSdk) return;
      let delta: ObservedSessionDelta | undefined;
      if (outcome === 'resolved') {
        delta = captureAdminWriteStreamDelta(base.bucket, base.path, self, writtenBytes, optionsMeta);
      }
      emitStreamRecord(
        adminRow.observer,
        helpers.moduleName,
        'File.createWriteStream',
        base,
        outcome,
        { uploadedBytes: writtenBytes },
        delta,
        helpers.codeOf,
        error,
      );
    };

    const proxy: Writable = new Writable({
      write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const chunkLen = numericByteLengthOf(chunk);
        if (chunkLen !== undefined) writtenBytes += chunkLen;
        ensureUnderlying()
          .then((target) => {
            target.write(chunk, encoding, callback);
          })
          .catch((err: unknown) => {
            callback(toError(err));
          });
      },
      final(callback: (error?: Error | null) => void) {
        ensureUnderlying()
          .then((target) => {
            const onFinish = (): void => {
              target.removeListener('error', onError);
              recordOnce('resolved');
              callback();
            };
            const onError = (err: unknown): void => {
              target.removeListener('finish', onFinish);
              recordOnce('rejected', err);
              callback(toError(err));
            };
            target.once('finish', onFinish);
            target.once('error', onError);
            target.end();
          })
          .catch((err: unknown) => {
            callback(toError(err));
          });
      },
      destroy(error: Error | null, callback: (error: Error | null) => void) {
        if (error !== null) recordOnce('rejected', error);
        if (underlying !== undefined && !underlying.destroyed) {
          underlying.destroy(error ?? undefined);
        }
        callback(error);
      },
    });

    function bridgeCustomEvent(target: Writable, event: string | symbol): void {
      if (bridgedCustomEvents.has(event)) return;
      bridgedCustomEvents.add(event);
      target.on(event, (...eventArgs: unknown[]) => {
        proxy.emit(event, ...eventArgs);
      });
    }

    proxy.on('newListener', (event: string | symbol) => {
      if (STANDARD_WRITABLE_EVENTS.has(event)) return;
      wantedCustomEvents.add(event);
      if (underlying !== undefined) {
        bridgeCustomEvent(underlying, event);
      }
    });

    let openPromise: Promise<Writable> | undefined;
    function ensureUnderlying(): Promise<Writable> {
      if (openPromise !== undefined) return openPromise;
      openPromise = adminRow.gate(adminRow.appOf(self), () =>
        runInsideAdminCall(() => {
          const created = Reflect.apply(realFn, self, args);
          reachedSdk = true;
          underlying = created;
          for (const event of wantedCustomEvents) {
            bridgeCustomEvent(created, event);
          }
          created.on('error', (err: unknown) => {
            recordOnce('rejected', err);
            if (!proxy.destroyed) {
              proxy.destroy(toError(err));
            }
          });
          return created;
        }),
      );
      return openPromise;
    }

    // Trigger gate check immediately so project/bucket refusals surface even on empty streams.
    ensureUnderlying().catch((err: unknown) => {
      if (!proxy.destroyed) {
        proxy.destroy(toError(err));
      }
    });

    return proxy;
  }, real as (this: unknown, ...args: unknown[]) => unknown);

  Object.defineProperty(prototype, 'createWriteStream', { ...descriptor, value: markAdminMethodGated(wrapped) });
  Object.defineProperty(prototype, WRITE_STREAM_PATCHED, { value: true });
}

/** Patches `File.prototype.createReadStream` once with project/bucket gating and byte counting. */
export function patchCreateReadStream(
  prototype: object | undefined,
  adminRow: AdminRow,
  helpers: StorageStreamHelpers,
): void {
  if (prototype === undefined || Object.hasOwn(prototype, READ_STREAM_PATCHED)) return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createReadStream');
  const real = descriptor?.value as unknown;
  if (typeof real !== 'function') return;
  const realFn = real as (this: unknown, ...args: unknown[]) => Readable;

  const wrapped = keepShape(function adminCreateReadStream(this: unknown, ...args: unknown[]): unknown {
    if (isObservingAdminCall()) {
      return Reflect.apply(realFn, this, args);
    }
    const self = this;
    const base = helpers.baseOf('createReadStream', args, self);

    let downloadedBytes = 0;
    let reachedSdk = false;
    let settled = false;
    let underlying: Readable | undefined;

    const recordOnce = (outcome: 'resolved' | 'rejected', error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (outcome === 'rejected' && !reachedSdk) return;
      emitStreamRecord(
        adminRow.observer,
        helpers.moduleName,
        'File.createReadStream',
        base,
        outcome,
        { downloadedBytes },
        undefined,
        helpers.codeOf,
        error,
      );
    };

    const proxy = new PassThrough();
    proxy.on('close', () => {
      if (underlying !== undefined && !underlying.destroyed) {
        underlying.destroy();
      }
    });

    adminRow
      .gate(adminRow.appOf(self), () => {
        if (proxy.destroyed) return undefined;
        return runInsideAdminCall(() => {
          const created = Reflect.apply(realFn, self, args);
          reachedSdk = true;
          underlying = created;
          created.on('response', (...eventArgs: unknown[]) => {
            proxy.emit('response', ...eventArgs);
          });
          created.on('data', (chunk: unknown) => {
            const chunkLen = numericByteLengthOf(chunk);
            if (chunkLen !== undefined) downloadedBytes += chunkLen;
          });
          created.on('end', () => {
            recordOnce('resolved');
          });
          created.on('error', (err: unknown) => {
            recordOnce('rejected', err);
            if (!proxy.destroyed) {
              proxy.destroy(toError(err));
            }
          });
          created.pipe(proxy);
          return created;
        });
      })
      .catch((err: unknown) => {
        if (!proxy.destroyed) {
          proxy.destroy(toError(err));
        }
      });

    return proxy;
  }, real as (this: unknown, ...args: unknown[]) => unknown);

  Object.defineProperty(prototype, 'createReadStream', { ...descriptor, value: markAdminMethodGated(wrapped) });
  Object.defineProperty(prototype, READ_STREAM_PATCHED, { value: true });
}
