import { describe, expect, it } from 'bun:test';
import {
  buildAtomsScopedRules,
  observeRulesAtomsVerdicts,
  type ConstraintRulesProbeClients,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-atoms-verdicts.ts';
import {
  buildPoliciesScopedRules,
  observeRulesPoliciesVerdicts,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-policies-verdicts.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

type RulesContextFactory = (databaseRules: Record<string, unknown>) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, RulesContextFactory]> = [
  ['served SharedWorker', (rules) => servedRtdbContext(rules)],
  ['served Node host', (rules) => hostedRtdbContext(rules)],
];

function wrapReplayRules(scopedRules: Record<string, unknown>): Record<string, unknown> {
  return {
    rules: {
      pyric_oracle: {
        replay: structuredClone(scopedRules),
      },
    },
  };
}

async function buildServedConstraintClients(
  ctx: ServedRtdbAdminContext,
  labelPrefix: string,
): Promise<{
  clients: ConstraintRulesProbeClients;
  seedAdminData: (subpath: string, value: unknown) => Promise<void>;
}> {
  const userA = await ctx.openAuthedClient(`${labelPrefix}-user-a`);
  const userB = await ctx.openAuthedClient(`${labelPrefix}-user-b`);
  const unauthed = await ctx.newClient(`${labelPrefix}-unauthed`);
  const adminDb = await ctx.openAdminDb();

  const seedAdminData = async (subpath: string, value: unknown): Promise<void> => {
    const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
    await adminDb.ref(`${ctx.base}/${cleanSub}`).set(value);
  };

  const clients: ConstraintRulesProbeClients = {
    userADb: userA.db as unknown as ConstraintRulesProbeClients['userADb'],
    userAUid: userA.uid,
    userBDb: userB.db as unknown as ConstraintRulesProbeClients['userBDb'],
    userBUid: userB.uid,
    unauthedDb: unauthed.db as unknown as ConstraintRulesProbeClients['unauthedDb'],
    ref: ctx.rtdb.ref as unknown as ConstraintRulesProbeClients['ref'],
    get: ctx.rtdb.get as unknown as ConstraintRulesProbeClients['get'],
    set: ctx.rtdb.set as unknown as ConstraintRulesProbeClients['set'],
    remove: ctx.rtdb.remove as unknown as ConstraintRulesProbeClients['remove'],
  };

  return { clients, seedAdminData };
}

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB constraint atoms and policies oracle captures (${planeLabel})`, () => {
    it('rtdb-rules-atoms-verdicts (rtdb#84, rtdb#66)', async () => {
      const scopedRules = buildAtomsScopedRules(['pyric_oracle', 'replay']);
      const ctx = await createContext(wrapReplayRules(scopedRules));
      const { clients, seedAdminData } = await buildServedConstraintClients(ctx, 'atoms');

      const actual = await observeRulesAtomsVerdicts(clients, ctx.base, seedAdminData);
      expect(actual as unknown).toEqual(load('rtdb-rules-atoms-verdicts'));
    });

    it('rtdb-rules-policies-verdicts (rtdb#85, rtdb#66)', async () => {
      const scopedRules = buildPoliciesScopedRules(['pyric_oracle', 'replay']);
      const ctx = await createContext(wrapReplayRules(scopedRules));
      const { clients, seedAdminData } = await buildServedConstraintClients(ctx, 'policies');

      const actual = await observeRulesPoliciesVerdicts(clients, ctx.base, seedAdminData);
      expect(actual as unknown).toEqual(load('rtdb-rules-policies-verdicts'));
    });

    it('rtdb#66: cross-path root.child(...).val() evaluates absent paths as null and reads live or multi-path sibling data', async () => {
      const ctx = await createContext({
        rules: {
          pyric_oracle: {
            replay: {
              gates: {
                whenUnseeded: {
                  '.read': "root.child('pyric_oracle/replay/flags/maintenance').val() === null",
                  '.write':
                    "auth != null && root.child('pyric_oracle/replay/roles').child(auth.uid).child('role').val() === 'admin'",
                },
              },
              rooms: {
                $roomId: {
                  meta: { '.write': 'auth != null' },
                  messages: {
                    '.write': 'auth != null',
                    '.validate': "newData.parent().child('meta/count').val() === 1",
                  },
                },
              },
            },
          },
        },
      });
      const alice = await ctx.openAuthedClient('rtdb66-alice');
      const adminDb = await ctx.openAdminDb();
      const gatePath = `${ctx.base}/gates/whenUnseeded`;

      expect((await ctx.rtdb.get(ctx.rtdb.ref(alice.db, gatePath))).val()).toBeNull();
      await expect(ctx.rtdb.set(ctx.rtdb.ref(alice.db, gatePath), { ok: true })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });

      await adminDb.ref(`${ctx.base}/roles/${alice.uid}/role`).set('admin');
      await adminDb.ref(`${ctx.base}/flags/maintenance`).set(true);
      await ctx.rtdb.set(ctx.rtdb.ref(alice.db, gatePath), { ok: true });
      await expect(ctx.rtdb.get(ctx.rtdb.ref(alice.db, gatePath))).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });

      await expect(
        ctx.rtdb.set(ctx.rtdb.ref(alice.db, `${ctx.base}/rooms/r1/messages`), { m1: 'hi' }),
      ).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await ctx.rtdb.update(ctx.rtdb.ref(alice.db, ctx.base), {
        'rooms/r1/meta/count': 1,
        'rooms/r1/messages': { m1: 'hi' },
      });
      expect((await adminDb.ref(`${ctx.base}/rooms/r1/messages`).get()).val()).toEqual({ m1: 'hi' });
    });
  });
}
