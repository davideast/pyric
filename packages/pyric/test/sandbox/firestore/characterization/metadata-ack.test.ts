/**
 * Characterization pins — snapshot metadata (hasPendingWrites / fromCache)
 * and the write-echo → server-ack delivery sequence.
 *
 * Pins current behavior through the public interface: a local write echoes
 * with hasPendingWrites:true; only includeMetadataChanges listeners receive
 * the follow-up ack (hasPendingWrites:false); fromCache is constant false.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

interface MetaPin {
  hasPendingWrites: boolean;
  fromCache: boolean;
}

interface SnapLike {
  metadata: MetaPin;
  data(): Record<string, unknown> | undefined;
}

function meta(snap: unknown): MetaPin {
  const s = snap as SnapLike;
  return {
    hasPendingWrites: s.metadata.hasPendingWrites,
    fromCache: s.metadata.fromCache,
  };
}

describe('characterization: metadata and server ack', () => {
  test('initial doc snapshot is settled: hasPendingWrites=false, fromCache=false', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const metas: MetaPin[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => metas.push(meta(s)),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(metas).toEqual([{ hasPendingWrites: false, fromCache: false }]);
    unsub();
  });

  test('default doc listener: a write delivers exactly ONE snapshot, hasPendingWrites=true, and NO ack follows', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const metas: MetaPin[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => metas.push(meta(s)),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    metas.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    // Give any stray scheduled ack a chance to drain on its own microtask.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    env.flushListeners();
    // PIN: default listener's last-seen snapshot stays pending:true forever.
    expect(metas).toEqual([{ hasPendingWrites: true, fromCache: false }]);
    unsub();
  });

  test('includeMetadataChanges doc listener: a write delivers echo (pending:true) then ack (pending:false) with the same data, in one flush pass', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fires: Array<{ meta: MetaPin; v: unknown }> = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => fires.push({ meta: meta(s), v: (s as SnapLike).data()?.v }),
      { includeMetadataChanges: true },
      { uid: 'alice' },
    );
    env.flushListeners();
    fires.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(fires).toEqual([
      { meta: { hasPendingWrites: true, fromCache: false }, v: 1 },
      { meta: { hasPendingWrites: false, fromCache: false }, v: 1 },
    ]);
    unsub();
  });

  test('the ack delivery event is metadata-only (added/modified/removed all 0) and attributes to the write', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const events: Array<{
      addedCount: number;
      modifiedCount: number;
      removedCount: number;
      size: number;
      triggeredBy?: { method: string; path: string };
    }> = [];
    const off = env.onSnapshotDelivery((e) =>
      events.push({
        addedCount: e.addedCount,
        modifiedCount: e.modifiedCount,
        removedCount: e.removedCount,
        size: e.size,
        triggeredBy: e.triggeredBy,
      }),
    );
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      () => {},
      { includeMetadataChanges: true },
      { uid: 'alice' },
    );
    env.flushListeners();
    events.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(events).toEqual([
      // Echo: one modified doc.
      {
        addedCount: 0,
        modifiedCount: 1,
        removedCount: 0,
        size: 1,
        triggeredBy: { method: 'update', path: 'rooms/r1' },
      },
      // Ack: metadata-only change, still attributed to the write
      // (capture-at-schedule).
      {
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        size: 1,
        triggeredBy: { method: 'update', path: 'rooms/r1' },
      },
    ]);
    off();
    unsub();
  });

  test('default query listener: write echo carries hasPendingWrites=true and no ack follows', async () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const metas: MetaPin[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      (s) => metas.push(meta(s)),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    expect(metas).toEqual([{ hasPendingWrites: false, fromCache: false }]);
    metas.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    env.flushListeners();
    expect(metas).toEqual([{ hasPendingWrites: true, fromCache: false }]);
    unsub();
  });

  test('includeMetadataChanges query listener: echo (pending:true) then ack (pending:false), same membership', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const fires: Array<{ meta: MetaPin; size: number }> = [];
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      (s) => {
        const q = s as { metadata: MetaPin; size: number };
        fires.push({ meta: meta(s), size: q.size });
      },
      { includeMetadataChanges: true },
      { uid: 'alice' },
    );
    env.flushListeners();
    fires.length = 0;

    env.execute({ method: 'create', path: 'rooms/r2', auth: { uid: 'alice' }, data: { v: 0 } });
    env.flushListeners();
    expect(fires).toEqual([
      { meta: { hasPendingWrites: true, fromCache: false }, size: 2 },
      { meta: { hasPendingWrites: false, fromCache: false }, size: 2 },
    ]);
    unsub();
  });

  test('per-doc snapshot metadata inside a query echo matches the snapshot-level metadata', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const docMetas: MetaPin[][] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'query', collection: 'rooms' },
      (s) => {
        const q = s as { docs: Array<{ metadata: MetaPin }> };
        docMetas.push(
          q.docs.map((d) => ({
            hasPendingWrites: d.metadata.hasPendingWrites,
            fromCache: d.metadata.fromCache,
          })),
        );
      },
      { includeMetadataChanges: true },
      { uid: 'alice' },
    );
    env.flushListeners();
    docMetas.length = 0;

    env.execute({ method: 'update', path: 'rooms/r1', auth: { uid: 'alice' }, data: { v: 1 } });
    env.flushListeners();
    expect(docMetas).toEqual([
      [{ hasPendingWrites: true, fromCache: false }], // echo
      [{ hasPendingWrites: false, fromCache: false }], // ack
    ]);
    unsub();
  });

  test('adminSetDocument echoes to listeners with hasPendingWrites=true, like a rule-allowed write', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'rooms/r1': { v: 0 } } });
    const metas: MetaPin[] = [];
    const unsub = env.addSnapshotListener(
      { kind: 'doc', path: 'rooms/r1' },
      (s) => metas.push(meta(s)),
      undefined,
      { uid: 'alice' },
    );
    env.flushListeners();
    metas.length = 0;

    env.adminSetDocument('rooms/r1', { v: 42 });
    env.flushListeners();
    expect(metas).toEqual([{ hasPendingWrites: true, fromCache: false }]);
    unsub();
  });
});
