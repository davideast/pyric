import type { FirestoreScenario } from '../scenario-types.ts';

const WRITE_MS = 15_000;

function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { m: value };
  return value;
}

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-write-map-depth-limit',
    rowIds: ['firestore#write-server-limits'],
    description: 'setDoc of a value nested in 26, 41, 101 and 102 maps, one client per write and a 15 s bound each. The 101 and 102 writes did not settle within the bound.',
  },
  async run({ fs, base, newClient, bounded }) {
    const out: Record<string, unknown> = {};
    for (const levels of [25, 40, 100, 101]) {
      const { db } = await newClient(`d${levels}`);
      const key = `maps ${levels + 1}`;
      try {
        await bounded('write', fs.setDoc(fs.doc(db, `${base}/depth/d${levels}`), { r: nest(levels) }), WRITE_MS);
        out[key] = { ok: true };
      } catch (error) {
        const { code, message } = error as { code?: string; message?: unknown };
        const timedOut = code === undefined && String(message) === 'write timeout';
        out[key] = timedOut
          ? { ok: false, code: 'probe-timeout', message: 'timeout 15s' }
          : { ok: false, code, message: String(message).slice(0, 160) };
      }
    }
    return out;
  },
};
