import {
  type DataSnapshot,
  child,
  endAt,
  off,
  onValue,
  orderByChild,
  query,
  ref,
  set,
  startAt,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-off-duplicate-registration',
      matrixRow: 'rtdb-modular#183, rtdb-modular#M92',
      rowIds: ['rtdb-modular#183', 'rtdb-modular#M92'],
      description:
        'Duplicate callback registration plus exact ref/query-view off() removal scope, with terminal state independently confirmed.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'off-duplicate-registration', attempt);
        const client = await createClient(ctx, `off-duplicate-registration-${attempt}`);
        try {
          const target = ref(client.db, path);
          await set(target, 0);
          const values: unknown[] = [];
          const controlValues: unknown[] = [];
          const callback = (snapshot: DataSnapshot) => values.push(snapshot.val());
          onValue(target, callback);
          onValue(target, callback);
          onValue(target, (snapshot) => controlValues.push(snapshot.val()));
          await waitFor('duplicate off initial readiness', () =>
            values.length === 2 && controlValues.at(-1) === 0);
          const afterInitial = [...values];
          await set(target, 1);
          await waitFor('duplicate off first write readiness', () =>
            values.length === 4 && controlValues.at(-1) === 1);
          const afterFirstWrite = [...values];
          off(target, 'value', callback);
          await set(target, 2);
          await waitFor('duplicate off first removal readiness', () =>
            values.length === 5 && controlValues.at(-1) === 2);
          const afterFirstOff = [...values];
          off(target, 'value', callback);
          await set(target, 3);
          await waitFor('duplicate off second removal readiness', () =>
            controlValues.at(-1) === 3);
          const queryTarget = ref(client.db, `${path}/query-scope`);
          await set(queryTarget, { a: { rank: 1 } });
          const defaultValues: unknown[] = [];
          const orderedValues: unknown[] = [];
          onValue(queryTarget, (snapshot) => defaultValues.push(snapshot.val()));
          onValue(query(queryTarget, orderByChild('rank')), (snapshot) => {
            orderedValues.push(snapshot.val());
          });
          await waitFor('query off initial readiness', () =>
            defaultValues.length === 1 && orderedValues.length === 1);
          off(query(queryTarget, orderByChild('rank')));
          await set(child(queryTarget, 'b'), { rank: 2 });
          await waitFor('query off exact-view readiness', () => defaultValues.length === 2);
          const afterQueryOff = {
            defaultCount: defaultValues.length,
            orderedCount: orderedValues.length,
          };
          const reorderedValues: unknown[] = [];
          const reorderedControl: unknown[] = [];
          onValue(query(queryTarget, orderByChild('rank'), startAt(1), endAt(3)), (snapshot) => {
            reorderedValues.push(snapshot.val());
          });
          onValue(queryTarget, (snapshot) => reorderedControl.push(snapshot.val()));
          await waitFor('reordered query off initial readiness', () =>
            reorderedValues.length === 1 && reorderedControl.length === 1);
          off(query(queryTarget, endAt(3), orderByChild('rank'), startAt(1)));
          await set(child(queryTarget, 'reordered'), { rank: 2 });
          await waitFor('reordered query off control readiness', () => reorderedControl.length === 2);
          const reorderedEquivalentStopped = reorderedValues.length === 1;
          const survivingQueryValues: unknown[] = [];
          onValue(query(queryTarget, orderByChild('rank')), (snapshot) => {
            survivingQueryValues.push(snapshot.val());
          });
          await waitFor('ref off query-survivor initial readiness', () =>
            survivingQueryValues.length === 1);
          off(queryTarget);
          const postRefOffControl: unknown[] = [];
          onValue(queryTarget, (snapshot) => postRefOffControl.push(snapshot.val()));
          await set(child(queryTarget, 'c'), { rank: 3 });
          await waitFor('ref off fresh-listener control readiness', () =>
            postRefOffControl.length === 2);
          const defaultTarget = ref(client.db, `${path}/default-equivalence`);
          await set(defaultTarget, 0);
          const referenceValues: unknown[] = [];
          onValue(defaultTarget, (snapshot) => referenceValues.push(snapshot.val()));
          await waitFor('default query equivalence initial readiness', () => referenceValues.length === 1);
          off(query(defaultTarget));
          const defaultControl: unknown[] = [];
          onValue(defaultTarget, (snapshot) => defaultControl.push(snapshot.val()));
          await set(defaultTarget, 1);
          await waitFor('default query equivalence control readiness', () => defaultControl.length === 2);
          return {
            afterInitial,
            afterFirstWrite,
            afterFirstOff,
            afterSecondOff: values,
            queryScope: {
              afterQueryOff,
              reorderedEquivalentStopped,
              defaultQueryStoppedReference: referenceValues.length === 1,
              constrainedStoppedByRefOff: survivingQueryValues.length === 1,
            },
            terminal: await adminRead(ctx, path),
          };
        } finally {
          off(ref(client.db, path));
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
