import { describe, expect, it } from 'bun:test';
import {
  ADMIN_QUERY_PROBE_RULES,
  observeAdminQueryBoundsListenersAndContext,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-query-bounds-listeners-and-context.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const DEFAULT_ORACLE_URL = 'https://demo-oracle-default-rtdb.firebaseio.com';

const SERVED_ADMIN_QUERY_RULES: Record<string, unknown> = {
  rules: {
    '.read': true,
    '.write': true,
    pyric_oracle: {
      replay: {
        ...ADMIN_QUERY_PROBE_RULES,
      },
    },
  },
};

type AdminPlaneFactory = () => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, AdminPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext(SERVED_ADMIN_QUERY_RULES)],
  ['served Node host', () => hostedRtdbContext(SERVED_ADMIN_QUERY_RULES)],
];

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB admin query bounds, listeners, and context oracle capture (${planeLabel})`, () => {
    it('rtdb-modular-admin-query-bounds-listeners-and-context (rtdb-admin#5)', async () => {
      const ctx = await createContext();
      const adminDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const cleanBase = ctx.base.replace(/^\/+|\/+$/g, '');
      const actual = await observeAdminQueryBoundsListenersAndContext(
        adminDb as unknown as Parameters<typeof observeAdminQueryBoundsListenersAndContext>[0],
        ctx.base,
        async (rankedSubpath) => {
          await adminDb.ref(`${cleanBase}/${rankedSubpath}`).set({
            k1: { label: 'one', '.priority': 30 },
            k2: { label: 'two', '.priority': 10 },
            k3: { label: 'no-prio' },
            k4: { label: 'str-prio', '.priority': 'high' },
          });
        },
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-admin-query-bounds-listeners-and-context'));
    });
  });
}
