import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export const WILDCARD_AND_INDEXON_ROUNDTRIP_RULES = {
  users: {
    $userId: {
      games: {
        $gameId: {
          '.read': '$userId === auth.uid',
          '.write':
            "$userId === auth.uid && newData.hasChildren(['gameId', 'score']) && newData.child('gameId').val() === $gameId",
          '.validate': "newData.child('score').isNumber()",
        },
      },
    },
  },
  leaderboard: {
    '.read': 'auth != null',
    '.write': 'auth != null',
    '.indexOn': ['score', 'turn'],
  },
  singleFieldIndex: {
    '.read': 'auth != null',
    '.write': 'auth != null',
    '.indexOn': 'rank',
  },
} as const;

export interface RulesRoundtripClientSdk {
  db: Database;
  uid: string;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  startAt: typeof import('firebase/database').startAt;
}

export async function observeRulesJsonWildcardAndIndexOnRoundtrip(
  sdk: RulesRoundtripClientSdk,
  basePath: string,
  fetchScopedRulesSubtree: () => Promise<unknown>,
): Promise<{
  fetchedScopedRulesJson: unknown;
  wildcardUserGameExecution: {
    matchingGameIdWriteAllowed: boolean;
    mismatchedGameIdWriteDenied: boolean;
    readBackStoredGame: unknown;
  };
  indexedOrderByChildExecution: {
    multiFieldScoreOrderKeys: string[];
    singleFieldRankOrderKeys: string[];
  };
}> {
  const fetchedScopedRulesJson = await fetchScopedRulesSubtree();

  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  let matchingGameIdWriteAllowed = false;
  try {
    await sdk.set(sdk.ref(sdk.db, `${prefix}users/${sdk.uid}/games/match-7`), {
      gameId: 'match-7',
      score: 45,
    });
    matchingGameIdWriteAllowed = true;
  } catch {
    matchingGameIdWriteAllowed = false;
  }

  let mismatchedGameIdWriteDenied = false;
  try {
    await sdk.set(sdk.ref(sdk.db, `${prefix}users/${sdk.uid}/games/match-8`), {
      gameId: 'wrong-id',
      score: 10,
    });
  } catch {
    mismatchedGameIdWriteDenied = true;
  }

  const storedGameSnap = await sdk.get(
    sdk.ref(sdk.db, `${prefix}users/${sdk.uid}/games/match-7`),
  );

  const lbRef = sdk.ref(sdk.db, `${prefix}leaderboard`);
  await sdk.set(lbRef, {
    p1: { score: 30, turn: 2 },
    p2: { score: 10, turn: 5 },
    p3: { score: 20, turn: 1 },
  });
  const lbQuerySnap = await sdk.get(
    sdk.query(lbRef, sdk.orderByChild('score'), sdk.startAt(15)),
  );
  const multiFieldScoreOrderKeys: string[] = [];
  lbQuerySnap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      multiFieldScoreOrderKeys.push(childSnap.key);
    }
    return false;
  });

  const singleIdxRef = sdk.ref(sdk.db, `${prefix}singleFieldIndex`);
  await sdk.set(singleIdxRef, {
    c: { rank: 3 },
    a: { rank: 1 },
    b: { rank: 2 },
  });
  const singleIdxSnap = await sdk.get(sdk.query(singleIdxRef, sdk.orderByChild('rank')));
  const singleFieldRankOrderKeys: string[] = [];
  singleIdxSnap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      singleFieldRankOrderKeys.push(childSnap.key);
    }
    return false;
  });

  return {
    fetchedScopedRulesJson,
    wildcardUserGameExecution: {
      matchingGameIdWriteAllowed,
      mismatchedGameIdWriteDenied,
      readBackStoredGame: storedGameSnap.val(),
    },
    indexedOrderByChildExecution: {
      multiFieldScoreOrderKeys,
      singleFieldRankOrderKeys,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Live RTDB Security Rules JSON deploy/fetch round-trip preserving nested $userId / $gameId path variables, .read/.write/.validate strings, and .indexOn array/string entries, plus live wildcard write and indexed orderByChild execution.',
  matrixRow: 'rtdb#90, rtdb#91, rtdb#92, rtdb#93',
  rowIds: ['rtdb#90', 'rtdb#91', 'rtdb#92', 'rtdb#93'],
  observe() {
    return withRtdbProbeSession(
      { runRules: { ...WILDCARD_AND_INDEXON_ROUNDTRIP_RULES } },
      async ({ runId, runPath, databaseUrl, openClient, rtdbSdk }) => {
        const sa = await loadOracleServiceAccount();
        const authed = await openClient('rules-roundtrip');
        const fetchScopedRulesSubtree = async (): Promise<unknown> => {
          const token = await oracleAccessToken(sa, RTDB_RULES_SCOPE);
          const cleanOrigin = databaseUrl.replace(/\/+$/g, '');
          const res = await fetch(
            `${cleanOrigin}/.settings/rules.json?access_token=${encodeURIComponent(token)}`,
          );
          if (!res.ok) {
            throw new Error(`GET /.settings/rules.json failed with HTTP ${res.status}`);
          }
          const body = (await res.json()) as {
            rules?: { pyric_oracle?: Record<string, unknown> };
          };
          const oracleMap = body.rules?.pyric_oracle;
          if (!oracleMap || typeof oracleMap !== 'object') {
            return null;
          }
          return oracleMap[runId] ?? null;
        };

        return observeRulesJsonWildcardAndIndexOnRoundtrip(
          {
            db: authed.db,
            uid: authed.uid,
            ref: rtdbSdk.ref,
            get: rtdbSdk.get,
            set: rtdbSdk.set,
            query: rtdbSdk.query,
            orderByChild: rtdbSdk.orderByChild,
            startAt: rtdbSdk.startAt,
          },
          runPath,
          fetchScopedRulesSubtree,
        );
      },
    );
  },
};
