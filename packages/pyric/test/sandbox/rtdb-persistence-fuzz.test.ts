/**
 * Seeded randomized differential test for incremental RTDB shard persistence.
 *
 * Applies hundreds of random operations across default and named RTDB instances
 * (shallow/deep writes, primitive promotions & demotions across depth 4, empty
 * ancestor trimming, root primitives, shallow & deep priorities, multi-path and
 * shallow updates, transactions, setData, setRules, reset/resetAll,
 * clearPersistence, and transient flush failures), asserting after every
 * successful flush that:
 *   1. Reloading persisted records into a fresh sandbox yields the exact same
 *      exported RTDB state (data, priorities, active rules) across instances.
 *   2. Persisted `rtdb:*` records in the backend match full-snapshot
 *      `serializeRtdbServiceToRecords` with zero stale or empty bucket records.
 */
import { describe, expect, it } from 'bun:test';
import {
  createMemoryBackend,
  initializeSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';
import { serializeRtdbServiceToRecords } from '../../src/sandbox/persistence/rtdb-records.js';
import {
  getDatabase as baseGetDatabase,
  getAdminDatabase,
  ref,
  set,
  setWithPriority,
  setPriority,
  update,
  remove,
  runTransaction,
  sandbox as rtdbSandbox,
  type Database,
} from '../../src/database/index.js';
import type { JsonValue } from '../../src/database/sandbox/data-tree.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRANCH_A = ['alpha', 'beta', 'gamma'];
const BRANCH_B = ['b0', 'b1', 'b2'];
const BRANCH_C = ['c0', 'c1'];
const BRANCH_D = ['d0', 'd1', 'd2'];
const BRANCH_E = ['e0', 'e1'];

const RULES_VARIANTS: Array<{ rules: Record<string, unknown> } | null> = [
  { rules: { '.read': true, '.write': true } },
  { rules: { alpha: { '.read': true, '.write': true }, beta: { '.read': true, '.write': true }, gamma: { '.read': true, '.write': true }, '.read': true, '.write': true } },
  null,
];

describe('rtdb persistence — seeded randomized differential fuzz', () => {
  for (const seed of [101, 202, 303, 404, 505, 606, 707, 808]) {
    it(`maintains exact equivalence and zero stale records across 200 random ops (seed=${seed})`, async () => {
      const rng = mulberry32(seed);
      const int = (max: number) => Math.floor(rng() * max);
      const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;

      const randomPath = (minDepth = 1, maxDepth = 6): string => {
        const depth = minDepth + int(maxDepth - minDepth + 1);
        const pools = [BRANCH_A, BRANCH_B, BRANCH_C, BRANCH_D, BRANCH_E, ['leaf0', 'leaf1']];
        const segs: string[] = [];
        for (let d = 0; d < depth; d++) {
          segs.push(pick(pools[d]!));
        }
        return `/${segs.join('/')}`;
      };

      const randomPriority = (): string | number =>
        rng() < 0.5 ? int(200) - 50 : `prio-${int(20)}`;

      const randomLeafOrSubtree = (step: number): JsonValue => {
        const roll = rng();
        if (roll < 0.25) return `str-${step}`;
        if (roll < 0.45) return step * 3 - 10;
        if (roll < 0.55) return (step & 1) === 0;
        if (roll < 0.70) return [`arr-${step}`, step] as unknown as JsonValue;
        return {
          k1: `v-${step}`,
          nested: { n: step, ok: true },
        };
      };

      const storage = createMemoryBackend();
      let injectFailure = false;
      const backend: PersistenceBackend = {
        ...storage,
        async applyChanges(key, changed, removed, serialized) {
          if (injectFailure) {
            injectFailure = false;
            throw new Error('injected transient commit failure');
          }
          await storage.putRecords(key, changed);
          await storage.deleteRecords(key, removed);
          if (serialized !== undefined) {
            for (const id of changed.keys()) {
              expect(serialized.has(id)).toBe(true);
            }
          }
        },
      };

      const key = `rtdb:fuzz:${seed}`;
      const live = initializeSandbox();
      await live.enablePersistence({ key, injectedBackend: backend, flushIntervalMs: 60_000 });

      const openDb = (sb: ReturnType<typeof initializeSandbox>, inst?: string): Database => {
        const db = inst ? baseGetDatabase(sb, `https://${inst}.firebaseio.com`) : baseGetDatabase(sb);
        rtdbSandbox.setDefaultPolicy(db, 'allow');
        return db;
      };

      const instances: Array<string | undefined> = [undefined, 'inst-one', 'inst-two'];
      const dbs = new Map<string, Database>();
      const getLiveDb = (inst?: string): Database => {
        const k = inst ?? '(default)';
        let db = dbs.get(k);
        if (!db) {
          db = openDb(live, inst);
          dbs.set(k, db);
        }
        return db;
      };
      // Ensure default db is initialized up front; named instances initialize as ops hit them.
      getLiveDb(undefined);

      const verifyEquivalence = async (stepLabel: string) => {
        const liveSnap = live.snapshot();
        const expectedRecords = serializeRtdbServiceToRecords(liveSnap.services.rtdb);
        expect(expectedRecords).not.toBeNull();

        const storedIds = (await storage.listRecords(key)).filter((id) => id.startsWith('rtdb:')).sort();
        const expectedIds = [...expectedRecords!.keys()].sort();
        expect(storedIds, `record ID mismatch at ${stepLabel}`).toEqual(expectedIds);

        for (const id of storedIds) {
          const actualRec = await storage.getRecord(key, id);
          expect(actualRec, `record payload mismatch for ${id} at ${stepLabel}`).toEqual(expectedRecords!.get(id));
        }

        const fresh = initializeSandbox();
        try {
          // Open same set of instances so default policy / registration matches.
          for (const instKey of dbs.keys()) {
            openDb(fresh, instKey === '(default)' ? undefined : instKey);
          }
          await fresh.enablePersistence({ key, injectedBackend: storage, flushIntervalMs: 60_000 });
          expect(fresh.snapshot().services.rtdb, `reload snapshot mismatch at ${stepLabel}`).toEqual(
            liveSnap.services.rtdb,
          );
        } finally {
          fresh.dispose();
        }
      };

      try {
        for (let step = 0; step < 200; step++) {
          const inst = rng() < 0.65 ? undefined : pick(instances);
          const db = rng() < 0.25
            ? (inst ? getAdminDatabase(live, `https://${inst}.firebaseio.com`) : getAdminDatabase(live))
            : getLiveDb(inst);
          const opRoll = rng();

          try {
            if (opRoll < 0.22) {
              // Deep set / setWithPriority (depth 4..6)
              const p = randomPath(4, 6);
              if (rng() < 0.35) {
                await setWithPriority(ref(db, p), randomLeafOrSubtree(step), randomPriority());
              } else {
                await set(ref(db, p), randomLeafOrSubtree(step));
              }
            } else if (opRoll < 0.40) {
              // Shallow set / setWithPriority (depth 1..3) — promotes or demotes across depth 4
              const p = randomPath(1, 3);
              if (rng() < 0.35) {
                await setWithPriority(ref(db, p), randomLeafOrSubtree(step), randomPriority());
              } else {
                await set(ref(db, p), randomLeafOrSubtree(step));
              }
            } else if (opRoll < 0.54) {
              // Remove at depth 1..6 (trims empty ancestors + prunes priorities)
              await remove(ref(db, randomPath(1, 6)));
            } else if (opRoll < 0.64) {
              // Priority write / clear at depth 0..6
              const p = rng() < 0.1 ? '/' : randomPath(1, 6);
              await setPriority(ref(db, p), rng() < 0.3 ? null : randomPriority());
            } else if (opRoll < 0.75) {
              // Multi-path or shallow update
              const base = rng() < 0.5 ? '/' : randomPath(1, 3);
              const p1 = randomPath(1, 3).slice(1);
              const p2 = randomPath(2, 4).slice(1);
              if (p1 !== p2 && !p1.startsWith(`${p2}/`) && !p2.startsWith(`${p1}/`)) {
                await update(ref(db, base), {
                  [p1]: rng() < 0.25 ? null : randomLeafOrSubtree(step),
                  [p2]: randomLeafOrSubtree(step + 1000),
                });
              }
            } else if (opRoll < 0.83) {
              // Transaction at depth 1..5
              const p = randomPath(1, 5);
              await runTransaction(ref(db, p), (cur) => {
                if (rng() < 0.15) return undefined; // abort
                if (cur !== null && rng() < 0.25) return null; // delete
                return { txStep: step, hadPrior: cur !== null };
              });
            } else if (opRoll < 0.88) {
              // Root primitive write or clear
              const rootVal = rng() < 0.2 ? null : rng() < 0.6 ? `root-${step}` : step;
              if (rootVal !== null && rng() < 0.4) {
                await setWithPriority(ref(db, '/'), rootVal, randomPriority());
              } else {
                await set(ref(db, '/'), rootVal);
              }
            } else if (opRoll < 0.92) {
              // Rules deploy / clear
              const rules = pick(RULES_VARIANTS);
              rtdbSandbox.setRules(getLiveDb(inst), rules);
            } else if (opRoll < 0.96) {
              // Bulk setData
              rtdbSandbox.setData(getLiveDb(inst), {
                [randomPath(2, 5)]: randomLeafOrSubtree(step),
                [randomPath(4, 6)]: { seeded: step },
              });
            } else if (opRoll < 0.985) {
              // Reset or resetAll
              if (rng() < 0.5) live.reset();
              else await live.resetAll();
            } else {
              // clearPersistence (wipes backend; next flush must re-emit full state)
              await live.clearPersistence();
            }
          } catch (err) {
            if (!(err instanceof Error && /permission/i.test(err.message))) {
              throw err;
            }
          }

          if (rng() < 0.22 || step === 199) {
            if (rng() < 0.20) {
              injectFailure = true;
              await expect(live.flush()).rejects.toThrow('injected transient commit failure');
            }
            await live.flush();
            await verifyEquivalence(`seed=${seed} step=${step}`);
          }
        }
      } finally {
        live.dispose();
      }
    });
  }
});
