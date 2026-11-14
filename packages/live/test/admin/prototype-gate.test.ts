import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { LiveCallRecord } from '../../src/observe.js';
import { isAdminMethodGated, type AdminRow } from '../../src/admin/patch.js';
import { adminProjectGate, type AdminApp } from '../../src/admin/project-gate.js';
import {
  gateInstanceStreamProperty,
  gatePrototypeMethods,
  patchAsyncGeneratorMethod,
  patchObjectStreamMethod,
  patchVoidUploadMethod,
  withExportedClass,
} from '../../src/admin/prototype-gate.js';

const HOST_PROJECT = 'proto-gate-host';

function makeApp(projectId: string): AdminApp {
  return { options: { projectId } };
}

describe('prototype-gate', () => {
  it('invokes withExportedClass both for populated exports and circular deferred exports', () => {
    const seen: string[] = [];
    class Immediate {}
    const immediateMod = { Immediate };
    withExportedClass(immediateMod, 'Immediate', (ctor) => seen.push(ctor.name));

    const deferredMod: Record<string, unknown> = {};
    withExportedClass(deferredMod, 'Deferred', (ctor) => seen.push(ctor.name));
    class Deferred {}
    deferredMod.Deferred = Deferred;

    expect(seen).toEqual(['Immediate', 'Deferred']);
    expect(deferredMod.Deferred).toBe(Deferred);
  });

  it('sweeps non-allowlisted prototype methods across promise and node-callback forms', async () => {
    class SampleService {
      readonly projectId: string;
      constructor(projectId: string) {
        this.projectId = projectId;
      }
      localHelper(): string {
        return this.projectId;
      }
      async fetchItem(id: string): Promise<string> {
        return `item:${id}`;
      }
      fetchTuple(id: string): Promise<[string, number]> {
        return Promise.resolve([id, 42]);
      }
    }

    const gate = adminProjectGate(HOST_PROJECT, () => undefined, {});
    Object.defineProperty(SampleService.prototype.fetchTuple, 'promisified_', { value: true });
    const appOf = (self: unknown): AdminApp => makeApp((self as SampleService).projectId);
    gatePrototypeMethods(SampleService.prototype, {
      gate,
      appOf,
      allowlist: new Set(['localHelper']),
      nodeCallback: true,
    });

    expect(isAdminMethodGated(SampleService.prototype.localHelper)).toBe(false);
    expect(isAdminMethodGated(SampleService.prototype.fetchItem)).toBe(true);
    expect(isAdminMethodGated(SampleService.prototype.fetchTuple)).toBe(true);

    const allowed = new SampleService(HOST_PROJECT);
    const refused = new SampleService('other-project');

    expect(await allowed.fetchItem('a')).toBe('item:a');
    const cbAllowed = await new Promise<unknown[]>((resolve) => {
      (allowed.fetchTuple as unknown as (id: string, cb: (...args: unknown[]) => void) => void)(
        'b',
        (...args) => resolve(args),
      );
    });
    expect(cbAllowed).toEqual([null, 'b', 42]);

    const refusedErr = await refused.fetchItem('a').catch((err: unknown) => err as { code?: string });
    expect(refusedErr).toMatchObject({ code: 'PYRIC_LIVE_REFUSED' });
    const cbRefused = await new Promise<{ code?: string }>((resolve) => {
      (refused.fetchTuple as unknown as (id: string, cb: (err: { code?: string }) => void) => void)(
        'b',
        (err) => resolve(err),
      );
    });
    expect(cbRefused.code).toBe('PYRIC_LIVE_REFUSED');
  });

  it('gates object streams, constructor-assigned streams, async generators, and void upload starters', async () => {
    const records: LiveCallRecord[] = [];
    const gate = adminProjectGate(HOST_PROJECT, () => undefined, {});
    class StreamHandle {
      readonly projectId: string;
      getItemsStream(): Readable {
        return new Readable({ objectMode: true });
      }
      constructor(projectId: string) {
        this.projectId = projectId;
        this.getItemsStream = () => Readable.from([{ id: '1' }], { objectMode: true });
      }
      stream(): Readable {
        return Readable.from([{ doc: 'a' }], { objectMode: true });
      }
      async *partitions(): AsyncGenerator<string> {
        yield 'p1';
        yield 'p2';
      }
      startUpload(dup: PassThrough): void {
        dup.end('ok');
      }
    }

    const row: AdminRow = {
      module: '@google-cloud/firestore',
      observer: (rec) => {
        records.push(rec);
      },
      gate,
      appOf: (self) => makeApp((self as StreamHandle).projectId),
    };

    patchObjectStreamMethod(StreamHandle.prototype, 'stream', row, 'Query', {
      observe: true,
      context: () => ({ projectId: HOST_PROJECT, path: 'items' }),
    });
    gateInstanceStreamProperty(StreamHandle.prototype, 'getItemsStream', row, 'Bucket', {
      observe: true,
      context: () => ({ projectId: HOST_PROJECT, bucket: 'bkt' }),
    });
    patchAsyncGeneratorMethod(StreamHandle.prototype, 'partitions', row, 'CollectionGroup', {
      observe: true,
      context: () => ({ projectId: HOST_PROJECT, path: 'items' }),
    });
    patchVoidUploadMethod(StreamHandle.prototype, 'startUpload', gate, row.appOf);

    const allowed = new StreamHandle(HOST_PROJECT);
    const refused = new StreamHandle('other-project');

    const chunks: unknown[] = [];
    for await (const item of allowed.stream()) chunks.push(item);
    expect(chunks).toEqual([{ doc: 'a' }]);

    const instChunks: unknown[] = [];
    for await (const item of allowed.getItemsStream()) instChunks.push(item);
    expect(instChunks).toEqual([{ id: '1' }]);

    const parts: string[] = [];
    for await (const part of allowed.partitions()) parts.push(part);
    expect(parts).toEqual(['p1', 'p2']);

    expect(records.map((r) => r.name)).toEqual([
      'Query.stream',
      'Bucket.getItemsStream',
      'CollectionGroup.partitions',
    ]);

    const streamErr = await (async () => {
      try {
        for await (const _ of refused.stream()) {
          // Unreachable.
        }
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    })();
    expect(streamErr).toBe('PYRIC_LIVE_REFUSED');

    const dup = new PassThrough();
    const dupErr = new Promise<{ code?: string }>((resolve) => {
      dup.once('error', (err) => resolve(err as { code?: string }));
    });
    refused.startUpload(dup);
    expect((await dupErr).code).toBe('PYRIC_LIVE_REFUSED');

    // Built-in root prototypes are never patched even if passed from a synthetic mock chain.
    gatePrototypeMethods(Object.prototype, { gate, appOf: row.appOf, allowlist: new Set() });
    gatePrototypeMethods(EventEmitter.prototype, { gate, appOf: row.appOf, allowlist: new Set() });
    expect(isAdminMethodGated(Object.prototype.toString)).toBe(false);
    expect(isAdminMethodGated(EventEmitter.prototype.on)).toBe(false);
  });
});
