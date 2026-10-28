import {
  get,
  onDisconnect,
  push,
  ref,
  remove,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  update,
} from 'firebase/database';
import {
  captureInvocation,
  createClient,
  repeatStable,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

/** Settle a task, or report it as pending after `ms`, so a write the server never answers cannot stall the probe. */
async function bounded(task: () => unknown, ms = 10_000): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Record<string, unknown>>((resolve) => {
    timer = setTimeout(() => resolve({ timing: 'pending' }), ms);
  });
  try {
    return await Promise.race([captureInvocation(task), pending]);
  } finally {
    clearTimeout(timer);
  }
}

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
    name: 'rtdb-modular-info-write-validation',
    matrixRow: 'rtdb-modular#M95',
    rowIds: ['rtdb-modular#M95'],
    description:
      'Every write API pointed at a location under `/.info`: set, setWithPriority, setPriority, remove, push, runTransaction, update on a `.info` reference and with a `.info/` key from the root, and each onDisconnect write, recording whether the client throws synchronously, rejects, or resolves, and the message. A get() of `.info/connected` is recorded alongside.',
    observe: () => repeatStable(2, async (attempt) => {
      const client = await createClient(ctx, `info-write-validation-${attempt}`);
      try {
        const connected = ref(client.db, '.info/connected');
        const info = ref(client.db, '.info');
        return {
          getConnected: await bounded(async () => (await get(connected)).val()),
          set: await bounded(() => set(connected, false)),
          setNested: await bounded(() => set(ref(client.db, '.info/custom/child'), 1)),
          setWithPriority: await bounded(() => setWithPriority(connected, false, 1)),
          setPriority: await bounded(() => setPriority(connected, 1)),
          remove: await bounded(() => remove(connected)),
          push: await bounded(() => push(info, 1)),
          runTransaction: await bounded(() => runTransaction(connected, () => false)),
          updateOnInfo: await bounded(() => update(info, { connected: false })),
          updateFromRoot: await bounded(() => update(ref(client.db), { '.info/connected': false })),
          onDisconnectSet: await bounded(() => onDisconnect(connected).set(false)),
          onDisconnectSetWithPriority: await bounded(() => onDisconnect(connected).setWithPriority(false, 1)),
          onDisconnectUpdate: await bounded(() => onDisconnect(info).update({ connected: false })),
          onDisconnectRemove: await bounded(() => onDisconnect(connected).remove()),
        };
      } finally {
        await client.close();
      }
    }),
  };
}
