import {
  ref,
  set,
  update,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  captureInvocation,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-write-return-validation',
      matrixRow: 'rtdb-modular#111, rtdb-modular#120',
      rowIds: ['rtdb-modular#111', 'rtdb-modular#120'],
      description:
        'set resolution value, overlapping update validation timing and atomic no-mutation proof, plus a successful non-overlapping control.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'write-return-validation', attempt);
        const client = await createClient(ctx, `write-return-validation-${attempt}`);
        try {
          const target = ref(client.db, path);
          const setResult = await set(target, { seed: true });
          const overlapping = await captureInvocation(() => update(target, { a: 1, 'a/b': 2 }));
          const afterRejected = await adminRead(ctx, path);
          const controlResult = await update(target, { 'left/value': 1, 'right/value': 2 });
          return {
            setResolution: setResult ?? null,
            overlapping,
            afterRejected,
            controlResolution: controlResult ?? null,
            terminal: await adminRead(ctx, path),
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
