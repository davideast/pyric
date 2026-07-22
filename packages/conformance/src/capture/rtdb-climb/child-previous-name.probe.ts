import {
  type DataSnapshot,
  child,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  orderByChild,
  orderByKey,
  query,
  ref,
  remove,
  set,
  setWithPriority,
  update,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
  stable,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-child-previous-name',
      matrixRow: 'rtdb-modular#M75, rtdb-modular#M75c',
      rowIds: ['rtdb-modular#M75', 'rtdb-modular#M75c'],
      description:
        'previousChildName values for initial replay, add/change/remove, and ordered movement, with terminal state independently confirmed.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'child-previous-name', attempt);
        const client = await createClient(ctx, `child-previous-name-${attempt}`);
        const target = ref(client.db, path);
        const plainPriorityTarget = ref(client.db, `${path}-plain-priority`);
        const added: Array<[string | null, string | null]> = [];
        const changed: Array<[string | null, string | null]> = [];
        const removed: Array<[string | null, string | null]> = [];
        const moved: Array<[string | null, string | null]> = [];
        const plainPriorityAdded: Array<[string | null, string | null]> = [];
        try {
          await set(target, {
            a: { rank: 1, stable: false },
            b: { rank: 2, stable: false },
            c: { rank: 3, stable: false },
          });
          const ordered = query(target, orderByKey());
          onChildAdded(ordered, (snap, previous) => { added.push([snap.key, previous ?? null]); });
          onChildChanged(ordered, ((snap: DataSnapshot, previous?: string | null) => {
            changed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void);
          onChildRemoved(ordered, ((snap: DataSnapshot, previous?: string | null) => {
            removed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void);
          const rankOrdered = query(target, orderByChild('rank'));
          onChildMoved(rankOrdered, (snap, previous) => moved.push([snap.key, previous]));
          await waitFor('child previous-name initial replay readiness', () => added.length === 3);
          const initialAdded = [...added];
          await set(child(target, 'd'), { rank: 4, stable: false });
          await waitFor('child previous-name addition readiness', () => added.length === 4);
          await update(child(target, 'b'), { stable: true });
          await waitFor('child previous-name first change readiness', () => changed.length === 1);
          await remove(child(target, 'a'));
          await waitFor('child previous-name removal readiness', () => removed.length === 1);
          await update(child(target, 'c'), { rank: 0 });
          await waitFor('child previous-name movement readiness', () =>
            changed.length === 2 && moved.length === 1);
          const terminal = await adminRead(ctx, path);
          await setWithPriority(child(plainPriorityTarget, 'z'), { value: 2 }, 2);
          await setWithPriority(child(plainPriorityTarget, 'a'), { value: 1 }, 1);
          onChildAdded(plainPriorityTarget, (snap, previous) => {
            plainPriorityAdded.push([snap.key, previous ?? null]);
          });
          await waitFor('plain child priority-order readiness', () =>
            plainPriorityAdded.length === 2);
          return {
            initialAdded,
            postMutationAdded: added.slice(initialAdded.length),
            changed,
            removed,
            moved,
            plainPriorityAdded,
            terminal,
          };
        } finally {
          off(target);
          off(plainPriorityTarget);
          await cleanup([
            () => client.close(),
            () => adminRemove(ctx, path),
            () => adminRemove(ctx, `${path}-plain-priority`),
          ]);
        }
      }),
    };
}
