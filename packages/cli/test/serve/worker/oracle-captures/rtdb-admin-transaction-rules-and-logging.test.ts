import { describe, expect, it } from 'bun:test';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import {
  enableLogging,
  getDatabase as getAdminDatabase,
  ServerValue,
} from 'pyric-admin/database';
import {
  observeAdminTransactionRulesAndLogging,
  type AdminTransactionRulesLoggingObservation,
  type AdminTxRulesLoggingSubject,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-transaction-rules-and-logging.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

type AdminPlaneFactory = () => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, AdminPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

function withContentionFinalVal(
  obs: AdminTransactionRulesLoggingObservation,
  finalVal: unknown,
): AdminTransactionRulesLoggingObservation {
  return {
    ...obs,
    transaction: {
      ...obs.transaction,
      twoClientContention: {
        ...obs.transaction.twoClientContention,
        finalVal,
      },
    },
  };
}

let appSeq = 0;

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB admin transaction, rules, and logging oracle capture (${planeLabel})`, () => {
    it('rtdb-modular-admin-transaction-rules-and-logging (rtdb-admin#8)', async () => {
      const ctx = await createContext();
      const rawObserved = load('rtdb-modular-admin-transaction-rules-and-logging');
      const observed = rawObserved as unknown as AdminTransactionRulesLoggingObservation;
      expect(observed.transaction.twoClientContention).toEqual({
        bothCommitted: true,
        finalVal: 1,
      });

      const remoteSandbox1 = await ctx.openRemoteSandbox();
      const remoteSandbox2 = await ctx.openRemoteSandbox();
      appSeq += 1;
      const runTag = `served_tx_rules_${appSeq}`;
      const app1 = initializeAdminApp(
        {
          sandbox: remoteSandbox1,
          projectId: 'demo-oracle',
          databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
        },
        `served-admin-tx-1-${appSeq}`,
      );
      const app2 = initializeAdminApp(
        {
          sandbox: remoteSandbox2,
          projectId: 'demo-oracle',
          databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
        },
        `served-admin-tx-2-${appSeq}`,
      );

      try {
        const db1 = getAdminDatabase(app1);
        const db2 = getAdminDatabase(app2);
        const cleanBase = ctx.base.replace(/^\/+|\/+$/g, '');
        let logPingSeq = 0;

        const subject: AdminTxRulesLoggingSubject = {
          db1: db1 as unknown as AdminTxRulesLoggingSubject['db1'],
          db2: db2 as unknown as AdminTxRulesLoggingSubject['db2'],
          basePath: `/${cleanBase}/${runTag}`,
          serverIncrement: (delta) =>
            ServerValue.increment(delta) as unknown as ReturnType<
              AdminTxRulesLoggingSubject['serverIncrement']
            >,
          enableLogging,
          async triggerLoggingActivity() {
            logPingSeq += 1;
            await db1.ref(`${cleanBase}/${runTag}/logPing/${logPingSeq}`).set(logPingSeq);
          },
          buildScopedRuleset(probeMarkerNode) {
            return {
              rules: {
                '.read': true,
                '.write': true,
                [runTag]: {
                  adminSetRulesProbe: probeMarkerNode,
                },
              },
            };
          },
          extractProbeMarker(rulesJson) {
            if (rulesJson === null || typeof rulesJson !== 'object') {
              return null;
            }
            const rulesRoot = (rulesJson as { rules?: Record<string, unknown> }).rules;
            if (!rulesRoot || typeof rulesRoot !== 'object') {
              return null;
            }
            const scopedNode = rulesRoot[runTag] as Record<string, unknown> | undefined;
            if (!scopedNode || typeof scopedNode !== 'object') {
              return null;
            }
            return scopedNode.adminSetRulesProbe ?? null;
          },
        };

        const actual = await observeAdminTransactionRulesAndLogging(subject);
        expect(actual.transaction.twoClientContention).toEqual({
          bothCommitted: true,
          finalVal: 11,
        });
        expect(actual).toEqual(withContentionFinalVal(observed, 11));
      } finally {
        enableLogging(false);
        await Promise.all([deleteAdminApp(app1), deleteAdminApp(app2)]);
      }
    });
  });
}
