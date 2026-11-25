import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox, type RemoteSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { enableLogging, getDatabase, ServerValue } from '../../src/database/index.js';
import {
  observeAdminTransactionRulesAndLogging,
  type AdminTransactionRulesLoggingObservation,
  type AdminTxRulesLoggingSubject,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-transaction-rules-and-logging.ts';
import { sharedWorkerArm } from './arms.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
);

function load(stemOrFile: string): AdminTransactionRulesLoggingObservation {
  let filename = `${stemOrFile}.json`;
  if (stemOrFile.endsWith('.json')) {
    filename = stemOrFile;
  }
  const parsed = JSON.parse(readFileSync(join(OBS_DIR, filename), 'utf8')) as {
    behavior: AdminTransactionRulesLoggingObservation;
  };
  return parsed.behavior;
}

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

let armSeq = 0;

const ARMS: ReadonlyArray<{
  name: string;
  makeSandbox: () => Sandbox | RemoteSandbox;
}> = [
  {
    name: 'in-process',
    makeSandbox() {
      armSeq += 1;
      return initializeSandbox({ projectId: `demo-admin-tx-rules-local-${armSeq}` });
    },
  },
  {
    name: 'remote (SharedWorker bridge)',
    makeSandbox() {
      const { app } = sharedWorkerArm();
      return app.sandbox;
    },
  },
];

afterEach(async () => {
  enableLogging(false);
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)(
  'RTDB admin transaction, rules, and logging oracle capture [$name]',
  ({ makeSandbox }) => {
    it('rtdb-modular-admin-transaction-rules-and-logging (rtdb-admin#8)', async () => {
      const observed = load('rtdb-modular-admin-transaction-rules-and-logging.json');
      expect(observed.transaction.twoClientContention).toEqual({
        bothCommitted: true,
        finalVal: 1,
      });

      const sharedSandbox = makeSandbox();
      armSeq += 1;
      const runTag = `run_${armSeq}`;
      const app1 = initializeApp(
        {
          sandbox: sharedSandbox,
          projectId: `demo-admin-tx-${armSeq}`,
          databaseURL: `https://demo-admin-tx-${armSeq}-default-rtdb.firebaseio.com`,
        },
        `pyric-admin-tx-1-${armSeq}`,
      );
      const app2 = initializeApp(
        {
          sandbox: sharedSandbox,
          projectId: `demo-admin-tx-${armSeq}`,
          databaseURL: `https://demo-admin-tx-${armSeq}-default-rtdb.firebaseio.com`,
        },
        `pyric-admin-tx-2-${armSeq}`,
      );
      const db1 = getDatabase(app1);
      const db2 = getDatabase(app2);
      let logPingSeq = 0;

      const subject: AdminTxRulesLoggingSubject = {
        db1: db1 as unknown as AdminTxRulesLoggingSubject['db1'],
        db2: db2 as unknown as AdminTxRulesLoggingSubject['db2'],
        basePath: `/pyric_oracle/${runTag}`,
        serverIncrement: (delta) =>
          ServerValue.increment(delta) as unknown as ReturnType<
            AdminTxRulesLoggingSubject['serverIncrement']
          >,
        enableLogging,
        async triggerLoggingActivity() {
          logPingSeq += 1;
          await db1.ref(`/pyric_oracle/${runTag}/logPing/${logPingSeq}`).set(logPingSeq);
        },
        buildScopedRuleset(probeMarkerNode) {
          return {
            rules: {
              pyric_oracle: {
                [runTag]: {
                  '.read': 'auth != null',
                  '.write': 'auth != null',
                  adminSetRulesProbe: probeMarkerNode,
                },
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
          const oracleNode = rulesRoot.pyric_oracle as Record<string, unknown> | undefined;
          if (!oracleNode || typeof oracleNode !== 'object') {
            return null;
          }
          const scopedNode = oracleNode[runTag] as Record<string, unknown> | undefined;
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
    });
  },
);
