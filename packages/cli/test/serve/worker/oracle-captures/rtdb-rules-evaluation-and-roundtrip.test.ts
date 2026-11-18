import { describe, expect, it } from 'bun:test';
import {
  CASCADE_BINDINGS_AUTH_RULES,
  observeRulesCascadeBindingsAndAuthContext,
  type RulesCascadeAuthClients,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import {
  DATA_NEWDATA_SNAPSHOT_RULES,
  observeRulesDataNewDataAndSnapshotMethods,
  type DataSnapshotMethodsProbeSdk,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-data-newdata-and-snapshot-methods.ts';
import {
  DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
  observeRulesDefaultDenyAndRuntimeErrors,
  type DefaultDenyAndRuntimeErrorSdk,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-default-deny-and-runtime-errors.ts';
import {
  observeRulesJsonWildcardAndIndexOnRoundtrip,
  WILDCARD_AND_INDEXON_ROUNDTRIP_RULES,
  type RulesRoundtripClientSdk,
} from '../../../../../conformance/probes/rtdb/rtdb-rules-json-wildcard-and-indexon-roundtrip.ts';
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

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB rules evaluation and JSON roundtrip oracle captures (${planeLabel})`, () => {
    it('rtdb-rules-cascade-bindings-and-auth-context (rtdb#61, #62, #63)', async () => {
      const ctx = await createContext(wrapReplayRules({ ...CASCADE_BINDINGS_AUTH_RULES }));
      const authed = await ctx.openAuthedClient('cascade-authed');
      const unauthed = await ctx.newClient('cascade-unauthed');
      const adminDb = await ctx.openAdminDb();
      const seedAdminData = async (subpath: string, value: unknown): Promise<void> => {
        const clean = subpath.replace(/^\/+|\/+$/g, '');
        await adminDb.ref(`${ctx.base}/${clean}`).set(value);
      };

      const clients: RulesCascadeAuthClients = {
        authedDb: authed.db as unknown as RulesCascadeAuthClients['authedDb'],
        authedUid: authed.uid,
        unauthedDb: unauthed.db as unknown as RulesCascadeAuthClients['unauthedDb'],
        ref: ctx.rtdb.ref as unknown as RulesCascadeAuthClients['ref'],
        get: ctx.rtdb.get as unknown as RulesCascadeAuthClients['get'],
        set: ctx.rtdb.set as unknown as RulesCascadeAuthClients['set'],
      };

      const actual = await observeRulesCascadeBindingsAndAuthContext(
        clients,
        ctx.base,
        seedAdminData,
      );
      expect(actual as unknown).toEqual(load('rtdb-rules-cascade-bindings-and-auth-context'));
    });

    it('rtdb-rules-data-newdata-and-snapshot-methods (rtdb#64, #65)', async () => {
      const ctx = await createContext(wrapReplayRules({ ...DATA_NEWDATA_SNAPSHOT_RULES }));
      const authed = await ctx.openAuthedClient('snapshot-authed');
      const adminDb = await ctx.openAdminDb();
      const seedAdminData = async (subpath: string, value: unknown): Promise<void> => {
        const clean = subpath.replace(/^\/+|\/+$/g, '');
        await adminDb.ref(`${ctx.base}/${clean}`).set(value);
      };

      const sdk: DataSnapshotMethodsProbeSdk = {
        db: authed.db as unknown as DataSnapshotMethodsProbeSdk['db'],
        ref: ctx.rtdb.ref as unknown as DataSnapshotMethodsProbeSdk['ref'],
        get: ctx.rtdb.get as unknown as DataSnapshotMethodsProbeSdk['get'],
        set: ctx.rtdb.set as unknown as DataSnapshotMethodsProbeSdk['set'],
        remove: ctx.rtdb.remove as unknown as DataSnapshotMethodsProbeSdk['remove'],
      };

      const actual = await observeRulesDataNewDataAndSnapshotMethods(sdk, ctx.base, seedAdminData);
      expect(actual as unknown).toEqual(load('rtdb-rules-data-newdata-and-snapshot-methods'));
    });

    it('rtdb-rules-default-deny-and-runtime-errors (rtdb#68, #69, #70)', async () => {
      const ctx = await createContext(wrapReplayRules({ ...DEFAULT_DENY_AND_RUNTIME_ERROR_RULES }));
      const authed = await ctx.openAuthedClient('deny-authed');
      const adminDb = await ctx.openAdminDb();
      const seedAdminData = async (subpath: string, value: unknown): Promise<void> => {
        const clean = subpath.replace(/^\/+|\/+$/g, '');
        await adminDb.ref(`${ctx.base}/${clean}`).set(value);
      };

      const sdk: DefaultDenyAndRuntimeErrorSdk = {
        db: authed.db as unknown as DefaultDenyAndRuntimeErrorSdk['db'],
        ref: ctx.rtdb.ref as unknown as DefaultDenyAndRuntimeErrorSdk['ref'],
        get: ctx.rtdb.get as unknown as DefaultDenyAndRuntimeErrorSdk['get'],
        set: ctx.rtdb.set as unknown as DefaultDenyAndRuntimeErrorSdk['set'],
      };

      const actual = await observeRulesDefaultDenyAndRuntimeErrors(sdk, ctx.base, seedAdminData);
      expect(actual as unknown).toEqual(load('rtdb-rules-default-deny-and-runtime-errors'));
    });

    it('rtdb-rules-json-wildcard-and-indexon-roundtrip (rtdb#90, #91, #92, #93)', async () => {
      const ctx = await createContext(wrapReplayRules({ ...WILDCARD_AND_INDEXON_ROUNDTRIP_RULES }));
      const authed = await ctx.openAuthedClient('roundtrip-authed');

      const sdk: RulesRoundtripClientSdk = {
        db: authed.db as unknown as RulesRoundtripClientSdk['db'],
        uid: authed.uid,
        ref: ctx.rtdb.ref as unknown as RulesRoundtripClientSdk['ref'],
        get: ctx.rtdb.get as unknown as RulesRoundtripClientSdk['get'],
        set: ctx.rtdb.set as unknown as RulesRoundtripClientSdk['set'],
        query: ctx.rtdb.query as unknown as RulesRoundtripClientSdk['query'],
        orderByChild: ctx.rtdb.orderByChild as unknown as RulesRoundtripClientSdk['orderByChild'],
        startAt: ctx.rtdb.startAt as unknown as RulesRoundtripClientSdk['startAt'],
      };

      const actual = await observeRulesJsonWildcardAndIndexOnRoundtrip(
        sdk,
        ctx.base,
        async () => structuredClone(WILDCARD_AND_INDEXON_ROUNDTRIP_RULES),
      );
      expect(actual as unknown).toEqual(load('rtdb-rules-json-wildcard-and-indexon-roundtrip'));
    });
  });
}
