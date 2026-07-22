import {
  type DataSnapshot,
  child,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  orderByChild,
  query,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';
import {
  adminRemove,
  cleanup,
  createClient,
  errorShape,
  repeatStable,
  scenarioPath,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-child-listener-only-once',
      matrixRow: 'rtdb-modular#M75d',
      rowIds: ['rtdb-modular#M75d'],
      description:
        'Child-listener options and cancellation-plus-options overloads stop after the first added, changed, removed, or moved delivery.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'child-listener-only-once', attempt);
        const client = await createClient(ctx, `child-listener-only-once-${attempt}`);
        const target = ref(client.db, path);
        const added: Array<[string | null, string | null]> = [];
        const changed: Array<[string | null, string | null]> = [];
        const removed: Array<[string | null, string | null]> = [];
        const moved: Array<[string | null, string | null]> = [];
        const controlAdded: Array<string | null> = [];
        const controlChanged: Array<string | null> = [];
        const controlRemoved: Array<string | null> = [];
        const controlMoved: Array<string | null> = [];
        const cancellations: Record<string, unknown>[] = [];
        try {
          await set(target, {
            a: { rank: 1, value: 1 },
            b: { rank: 2, value: 2 },
            c: { rank: 3, value: 3 },
          });
          onChildAdded(target, (snap, previous) => { added.push([snap.key, previous]); }, { onlyOnce: true });
          onChildChanged(
            target,
            (snap, previous) => { changed.push([snap.key, previous]); },
            (error) => cancellations.push(errorShape(error)),
            { onlyOnce: true },
          );
          onChildRemoved(target, ((snap: DataSnapshot, previous?: string | null) => {
            removed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void, { onlyOnce: true });
          onChildMoved(
            query(target, orderByChild('rank')),
            (snap, previous) => { moved.push([snap.key, previous]); },
            { onlyOnce: true },
          );
          onChildAdded(target, (snap) => { controlAdded.push(snap.key); });
          onChildChanged(target, (snap) => { controlChanged.push(snap.key); });
          onChildRemoved(target, (snap) => { controlRemoved.push(snap.key); });
          onChildMoved(query(target, orderByChild('rank')), (snap) => {
            controlMoved.push(snap.key);
          });
          await waitFor('child onlyOnce initial replay readiness', () =>
            added.length === 3 && controlAdded.length === 3);
          await update(child(target, 'a'), { value: 10, rank: 4 });
          await waitFor('child onlyOnce first change readiness', () =>
            controlChanged.length === 1 && controlMoved.length === 1);
          await update(child(target, 'a'), { value: 11, rank: 0 });
          await waitFor('child onlyOnce second change readiness', () =>
            controlChanged.length === 2 && controlMoved.length === 2);
          await remove(child(target, 'b'));
          await waitFor('child onlyOnce first removal readiness', () =>
            controlRemoved.length === 1);
          await remove(child(target, 'c'));
          await waitFor('child onlyOnce second removal readiness', () =>
            controlRemoved.length === 2);
          await set(child(target, 'd'), { rank: 5, value: 4 });
          await waitFor('child onlyOnce later addition readiness', () =>
            controlAdded.length === 4);
          return { added, changed, removed, moved, cancellations };
        } finally {
          off(target);
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
