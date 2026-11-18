import { describe, expect, test } from 'bun:test';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeAdminFirebaseDatabaseErrorAndUrlBinding,
  probe as adminErrorAndUrlProbe,
  type AdminErrorAndUrlSdk,
  type FirebaseDatabaseErrorConstructorLike,
} from '../../probes/rtdb-modular/rtdb-modular-admin-firebasedatabaseerror-and-url-binding.ts';
import {
  observeAdminPrioritiesAndInlinePriority,
  probe as adminPrioritiesProbe,
} from '../../probes/rtdb-modular/rtdb-modular-admin-priorities-and-inline-priority.ts';
import {
  observeRulesJsonWildcardAndIndexOnRoundtrip,
  probe as rulesJsonRoundtripProbe,
  WILDCARD_AND_INDEXON_ROUNDTRIP_RULES,
  type RulesRoundtripClientSdk,
} from '../../probes/rtdb/rtdb-rules-json-wildcard-and-indexon-roundtrip.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const SLICE7_PROBE_IDS = [
  'rtdb-modular-admin-priorities-and-inline-priority',
  'rtdb-modular-admin-firebasedatabaseerror-and-url-binding',
  'rtdb-rules-json-wildcard-and-indexon-roundtrip',
] as const;

function assertValidPriority(fnName: string, prio: unknown): void {
  if (typeof prio === 'number') {
    if (Number.isNaN(prio)) {
      throw new Error(
        `${fnName} failed: priority argument is NaN, but must be a valid Firebase priority (a string, finite number, server value, or null).`,
      );
    }
    if (!Number.isFinite(prio)) {
      throw new Error(
        `${fnName} failed: priority argument must be a valid Firebase priority (a string, finite number, server value, or null).`,
      );
    }
    return;
  }
  if (typeof prio === 'string' || prio === null) {
    return;
  }
  throw new Error(
    `${fnName} failed: priority argument must be a valid Firebase priority (a string, finite number, server value, or null).`,
  );
}

function assertValidPayload(fnName: string, dotPath: string, val: unknown): void {
  if (val === undefined) {
    throw new Error(`${fnName} failed: value argument contains undefined in property '${dotPath}'`);
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      assertValidPayload(fnName, `${dotPath}.${k}`, v);
    }
  }
}

function createAdminPriorityTestHarness() {
  const sandbox = initializeSandbox({ projectId: 'demo-admin-prio-test' });
  const rawDb = pyricRtdb.getAdminDatabase(sandbox);

  function toExportVal(snap: pyricRtdb.DataSnapshot): unknown {
    const val = snap.val();
    const prio = snap.priority;
    if (val === null) {
      return null;
    }
    if (typeof val !== 'object' || Array.isArray(val)) {
      if (prio !== null) {
        return { '.value': val, '.priority': prio };
      }
      return val;
    }
    const out: Record<string, unknown> = {};
    snap.forEach((childSnap) => {
      if (childSnap.key !== null) {
        out[childSnap.key] = toExportVal(childSnap);
      }
      return false;
    });
    if (prio !== null) {
      out['.priority'] = prio;
    }
    return out;
  }

  function wrapSnap(snap: pyricRtdb.DataSnapshot) {
    return {
      val: () => snap.val(),
      getPriority: () => snap.priority,
      exportVal: () => toExportVal(snap),
      forEach(cb: (child: { key: string | null }) => boolean | undefined) {
        return snap.forEach((c) => cb({ key: c.key }));
      },
    };
  }

  function makeRef(path: string) {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const dotPath = clean.split('/').join('.');
    const underlying = pyricRtdb.ref(rawDb, clean);
    return {
      child(sub: string) {
        return makeRef(`${clean}/${sub.replace(/^\/+|\/+$/g, '')}`);
      },
      set(val: unknown) {
        assertValidPayload('set', dotPath, val);
        return pyricRtdb.set(underlying, val);
      },
      update(values: Record<string, unknown>) {
        assertValidPayload('update', dotPath, values);
        return pyricRtdb.update(underlying, values);
      },
      setWithPriority(
        newVal: unknown,
        newPriority: string | number | null,
        onComplete?: (a: Error | null) => void,
      ) {
        assertValidPayload('setWithPriority', dotPath, newVal);
        assertValidPriority('setWithPriority', newPriority);
        return pyricRtdb.setWithPriority(underlying, newVal, newPriority).then(() => {
          if (onComplete) {
            onComplete(null);
          }
        });
      },
      setPriority(
        priority: string | number | null,
        onComplete: (a: Error | null) => void,
      ) {
        assertValidPriority('setPriority', priority);
        return pyricRtdb.setPriority(underlying, priority).then(() => {
          onComplete(null);
        });
      },
      async get() {
        const snap = await pyricRtdb.get(underlying);
        return wrapSnap(snap);
      },
      orderByPriority() {
        const q = pyricRtdb.query(underlying, pyricRtdb.orderByPriority());
        return {
          async get() {
            const snap = await pyricRtdb.get(q);
            return wrapSnap(snap);
          },
        };
      },
    };
  }

  return {
    ref: makeRef,
  };
}

describe('RTDB Slice 7 staged probes: admin priorities, FirebaseDatabaseError/URL binding, and rules JSON round-trip', () => {
  test('registers all 3 Slice 7 probes with pendingRowLink and empty rowIds under expected surface directories', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));

    expect(byId.get('rtdb-modular-admin-priorities-and-inline-priority')?.surfaceDir).toBe(
      'rtdb-modular',
    );
    expect(byId.get('rtdb-modular-admin-firebasedatabaseerror-and-url-binding')?.surfaceDir).toBe(
      'rtdb-modular',
    );
    expect(byId.get('rtdb-rules-json-wildcard-and-indexon-roundtrip')?.surfaceDir).toBe('rtdb');

    for (const p of [adminPrioritiesProbe, adminErrorAndUrlProbe, rulesJsonRoundtripProbe]) {
      expect(p.rig).toBe('sdk-probes');
      expect(p.requires).toEqual(['web-config', 'dedicated-rtdb']);
      expect(p.pendingRowLink).toBe(true);
      expect(p.matrixRow).toBe('');
      expect(p.rowIds).toEqual([]);
      expect(p.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(SLICE7_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    for (const id of SLICE7_PROBE_IDS) {
      expect(previewLines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes setWithPriority, setPriority, inline .priority/.value, orderByPriority, and scrubbed validation throws', async () => {
    const adminDb = createAdminPriorityTestHarness() as unknown as Parameters<
      typeof observeAdminPrioritiesAndInlinePriority
    >[0];
    const r1 = await observeAdminPrioritiesAndInlinePriority(adminDb, '/pyric_oracle/rtdb_run_one');
    const r2 = await observeAdminPrioritiesAndInlinePriority(adminDb, '/pyric_oracle/rtdb_run_two');

    expect(r1).toEqual(r2);
    expect(r1.setWithPriorityAndSetPriority).toEqual({
      initialVal: { label: 'alpha' },
      initialPriority: 25,
      initialExportVal: { label: 'alpha', '.priority': 25 },
      afterSetPriorityNumber: 5,
      afterSetPriorityString: 'rank-b',
      afterClearPriorityNull: null,
      afterClearExportVal: { label: 'alpha' },
      priorityOnEmptyNodeRemainsNull: null,
      callbacksDeliveredNullError: {
        setWithPriority: true,
        setPriority: true,
      },
    });
    expect(r1.inlinePriorityInSetAndUpdate).toEqual({
      inlinePrimitiveVal: 'scalar-payload',
      inlinePrimitivePriority: 12,
      inlinePrimitiveExportVal: { '.value': 'scalar-payload', '.priority': 12 },
      inlineObjectVal: { title: 'doc', count: 2 },
      inlineObjectPriority: 'p-high',
      inlineObjectExportVal: { title: 'doc', count: 2, '.priority': 'p-high' },
      afterUpdateInlineChildOrderByPriorityKeys: ['b', 'c', 'a'],
      afterUpdateChildExportVal: { '.value': 'second', '.priority': 20 },
    });
    expect(r1.validationThrows.every((c) => c.threwSynchronously)).toBe(true);
    expect(JSON.stringify(r1.validationThrows)).not.toContain('rtdb_run_');
  });

  test('observes FirebaseDatabaseError runtime constructor contract and URL handle caching / validation throws', async () => {
    class MockFirebaseDatabaseError extends Error {
      readonly code: string;
      override readonly message: string;
      constructor(info: { code: string; message: string }, message?: string) {
        const resolved = message || info.message;
        super(resolved);
        this.code = `database/${info.code}`;
        this.message = resolved;
      }
      toJSON() {
        return { code: this.code, message: this.message };
      }
    }

    const sandbox = initializeSandbox({ projectId: 'demo-url-bind' });
    const rawDb = pyricRtdb.getAdminDatabase(sandbox);
    const appHandles = new WeakMap<object, Map<string, unknown>>();

    const sdk: AdminErrorAndUrlSdk = {
      FirebaseDatabaseError:
        MockFirebaseDatabaseError as unknown as FirebaseDatabaseErrorConstructorLike,
      createTempApp(options, label) {
        const appObj = { options, name: label };
        appHandles.set(appObj, new Map());
        return appObj as unknown as ReturnType<AdminErrorAndUrlSdk['createTempApp']>;
      },
      async deleteTempApp() {},
      getDatabase(app) {
        const targetApp = app as unknown as { options: { databaseURL?: string } };
        if (!targetApp.options.databaseURL) {
          throw new MockFirebaseDatabaseError({
            code: 'invalid-argument',
            message: "Can't determine Firebase Database URL.",
          });
        }
        return this.getDatabaseWithUrl(targetApp.options.databaseURL, app);
      },
      getDatabaseWithUrl(url, app) {
        if (!url) {
          throw new MockFirebaseDatabaseError({
            code: 'invalid-argument',
            message: 'Database URL must be a valid, non-empty URL string.',
          });
        }
        const map = appHandles.get(app as object);
        if (!map) {
          throw new Error('Missing app map');
        }
        const existing = map.get(url);
        if (existing) {
          return existing as ReturnType<AdminErrorAndUrlSdk['getDatabaseWithUrl']>;
        }
        if (map.size > 0) {
          throw new Error(
            'FIREBASE FATAL ERROR: Database initialized multiple times. Please make sure the format of the database URL matches with each database() call. ',
          );
        }
        const handle = {
          goOffline() {},
          ref(path: string) {
            const r = pyricRtdb.ref(rawDb, path.replace(/^\/+|\/+$/g, ''));
            return {
              set: (val: unknown) => pyricRtdb.set(r, val),
              get: () => pyricRtdb.get(r),
            };
          },
        };
        map.set(url, handle);
        return handle as unknown as ReturnType<AdminErrorAndUrlSdk['getDatabaseWithUrl']>;
      },
    };

    const obs = await observeAdminFirebaseDatabaseErrorAndUrlBinding(
      sdk,
      'https://demo-url-bind-default-rtdb.firebaseio.com/',
      '/pyric_oracle/rtdb_url_test',
    );
    expect(obs.errorConstructorContract).toEqual({
      exportedAsFunction: true,
      defaultMessageInstanceIsError: true,
      defaultCodePrefixed: 'database/invalid-argument',
      defaultMessage: 'Default info message.',
      defaultToJson: { code: 'database/invalid-argument', message: 'Default info message.' },
      overrideMessageApplied: 'Explicit override message.',
      overrideToJson: { code: 'database/network-error', message: 'Explicit override message.' },
    });
    expect(obs.urlBindingAndHandleCaching.sameExactUrlReturnsSameHandle).toBe(true);
    expect(obs.urlBindingAndHandleCaching.appOptionsUrlMatchesExplicitGetDatabaseWithUrl).toBe(
      true,
    );
    expect(
      obs.urlBindingAndHandleCaching.liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl,
    ).toEqual({ bound: true, seq: 1 });
    expect(obs.urlBindingAndHandleCaching.trailingSlashVariantOnOpenInstance.threw).toBe(true);
    expect(obs.urlBindingAndHandleCaching.missingDatabaseUrlThrow.code).toBe(
      'database/invalid-argument',
    );
    expect(obs.urlBindingAndHandleCaching.emptyUrlGetDatabaseWithUrlThrow.code).toBe(
      'database/invalid-argument',
    );
  });

  test('observes rules JSON wildcard ($userId / $gameId) and .indexOn round-trip plus live execution', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-rules-roundtrip' });
    const db = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'player-1' }));
    const basePath = 'probe_roundtrip';
    const scopedRules = structuredClone(WILDCARD_AND_INDEXON_ROUNDTRIP_RULES);
    pyricRtdb.sandbox.setRules(db, {
      rules: {
        [basePath]: scopedRules,
      },
    });

    const clientSdk: RulesRoundtripClientSdk = {
      db: db as unknown as RulesRoundtripClientSdk['db'],
      uid: 'player-1',
      ref: pyricRtdb.ref as unknown as RulesRoundtripClientSdk['ref'],
      get: pyricRtdb.get as unknown as RulesRoundtripClientSdk['get'],
      set: pyricRtdb.set as unknown as RulesRoundtripClientSdk['set'],
      query: pyricRtdb.query as unknown as RulesRoundtripClientSdk['query'],
      orderByChild: pyricRtdb.orderByChild as unknown as RulesRoundtripClientSdk['orderByChild'],
      startAt: pyricRtdb.startAt as unknown as RulesRoundtripClientSdk['startAt'],
    };

    const result = await observeRulesJsonWildcardAndIndexOnRoundtrip(
      clientSdk,
      basePath,
      async () => scopedRules,
    );
    expect(result.fetchedScopedRulesJson).toEqual(WILDCARD_AND_INDEXON_ROUNDTRIP_RULES);
    expect(result.wildcardUserGameExecution).toEqual({
      matchingGameIdWriteAllowed: true,
      mismatchedGameIdWriteDenied: true,
      readBackStoredGame: { gameId: 'match-7', score: 45 },
    });
    expect(result.indexedOrderByChildExecution).toEqual({
      multiFieldScoreOrderKeys: ['p3', 'p1'],
      singleFieldRankOrderKeys: ['a', 'b', 'c'],
    });
  });
});
