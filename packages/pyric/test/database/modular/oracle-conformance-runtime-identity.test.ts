/** Focused real-Firebase oracle replay: runtime identity. */
import { describe, it, expect } from 'bun:test';
import * as databaseModule from '../../../src/database/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp } from '../../../src/app/index.js';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { getAdminDatabase, getDatabase } from '../../../src/database/index.js';
import {
  ref,
  get,
  set,
  runTransaction,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  startAt,
  startAfter,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
} from '../../../src/database/index.js';
import {
  load,
  setup,
} from './oracle-conformance.support.js';

describe('oracle conformance (rtdb-modular): runtime identity', () => {
  describe('runtime class values', () => {
    it('rtdb-modular#M85 Database runtime identity', () => {
      const obs = load('rtdb-modular-runtime-class-identity.json');
      const expected = (obs.exportTypes as Record<string, string>).Database;
      const constructor = (databaseModule as Record<string, unknown>).Database;
      expect(typeof constructor).toBe(expected);
      const { db } = setup();
      expect(db.constructor.name).toBe(
        (obs.database as Record<string, unknown>).constructorName,
      );
      expect(db instanceof (constructor as new () => object)).toBe(
        (obs.database as Record<string, boolean>).instanceOf,
      );
      expect(Object.getPrototypeOf(db) === (constructor as Function).prototype).toBe(
        (obs.database as Record<string, boolean>).prototypeIsExportPrototype,
      );
      expect(Object.getOwnPropertyNames((constructor as Function).prototype).sort()).toEqual(
        (obs.database as Record<string, unknown>).prototypeKeys,
      );
      const direct = new (constructor as new () => object)();
      expect({
        threw: false,
        constructorName: direct.constructor.name,
        ownKeys: Object.keys(direct).sort(),
      }).toEqual((obs.directConstruction as Record<string, unknown>).Database);
    });

    it('rtdb-modular#M86 DataSnapshot runtime identity', async () => {
      const obs = load('rtdb-modular-runtime-class-identity.json');
      const expected = (obs.exportTypes as Record<string, string>).DataSnapshot;
      const constructor = (databaseModule as Record<string, unknown>).DataSnapshot;
      expect(typeof constructor).toBe(expected);
      const { db } = setup();
      await set(ref(db, 'runtime-snapshot'), { value: 1 });
      const snapshot = await get(ref(db, 'runtime-snapshot'));
      expect(snapshot.constructor.name).toBe(
        (obs.snapshot as Record<string, unknown>).constructorName,
      );
      expect(snapshot instanceof (constructor as new () => object)).toBe(
        (obs.snapshot as Record<string, boolean>).instanceOf,
      );
      expect(Object.getPrototypeOf(snapshot) === (constructor as Function).prototype).toBe(
        (obs.snapshot as Record<string, boolean>).prototypeIsExportPrototype,
      );
      expect(Object.getOwnPropertyNames((constructor as Function).prototype).sort()).toEqual(
        (obs.snapshot as Record<string, unknown>).prototypeKeys,
      );
      const direct = new (constructor as new () => object)();
      expect({
        threw: false,
        constructorName: direct.constructor.name,
        ownKeys: Object.keys(direct).sort(),
      }).toEqual((obs.directConstruction as Record<string, unknown>).DataSnapshot);
    });

    it('rtdb-modular#M87 QueryConstraint runtime identity', () => {
      const obs = load('rtdb-modular-runtime-class-identity.json');
      const expected = (obs.exportTypes as Record<string, string>).QueryConstraint;
      const constructor = (databaseModule as Record<string, unknown>).QueryConstraint;
      expect(typeof constructor).toBe(expected);
      const constraint = orderByKey();
      expect(constraint.constructor.name).toBe(
        (obs.queryConstraint as Record<string, unknown>).constructorName,
      );
      expect(constraint instanceof (constructor as new () => object)).toBe(
        (obs.queryConstraint as Record<string, boolean>).instanceOf,
      );
      expect(Object.getPrototypeOf(constraint) === (constructor as Function).prototype).toBe(
        (obs.queryConstraint as Record<string, boolean>).prototypeIsExportPrototype,
      );
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(constraint) as object).sort()).toEqual(
        (obs.queryConstraint as Record<string, unknown>).prototypeKeys,
      );
      const factories = {
        orderByChild: orderByChild('value'),
        orderByKey: orderByKey(),
        orderByPriority: orderByPriority(),
        orderByValue: orderByValue(),
        startAt: startAt(1),
        startAfter: startAfter(1),
        endAt: endAt(1),
        endBefore: endBefore(1),
        equalTo: equalTo(1),
        limitToFirst: limitToFirst(1),
        limitToLast: limitToLast(1),
      };
      const observedFactories = obs.constraintFactories as Record<string, Record<string, unknown>>;
      for (const [name, factoryConstraint] of Object.entries(factories)) {
        const observed = observedFactories[name]!;
        expect({
          constructorName: factoryConstraint.constructor.name,
          instanceOf: factoryConstraint instanceof (constructor as new () => object),
          prototypeIsExportPrototype:
            Object.getPrototypeOf(factoryConstraint) === (constructor as Function).prototype,
          prototypeKeys: Object.getOwnPropertyNames(
            Object.getPrototypeOf(factoryConstraint) as object,
          ).sort(),
        }).toEqual(observed);
      }
      const direct = new (constructor as new () => object)();
      expect({
        threw: false,
        constructorName: direct.constructor.name,
        ownKeys: Object.keys(direct).sort(),
      }).toEqual((obs.directConstruction as Record<string, unknown>).QueryConstraint);
    });

    it('rtdb-modular#M88 TransactionResult runtime identity and toJSON', async () => {
      const obs = load('rtdb-modular-runtime-class-identity.json');
      const expected = (obs.exportTypes as Record<string, string>).TransactionResult;
      const constructor = (databaseModule as Record<string, unknown>).TransactionResult;
      expect(typeof constructor).toBe(expected);
      const { db } = setup();
      const result = await runTransaction(ref(db, 'runtime-transaction'), () => 1);
      expect(result.constructor.name).toBe(
        (obs.transactionResult as Record<string, unknown>).constructorName,
      );
      expect(result instanceof (constructor as new () => object)).toBe(
        (obs.transactionResult as Record<string, boolean>).instanceOf,
      );
      expect(Object.getPrototypeOf(result) === (constructor as Function).prototype).toBe(
        (obs.transactionResult as Record<string, boolean>).prototypeIsExportPrototype,
      );
      expect(Object.getOwnPropertyNames((constructor as Function).prototype).sort()).toEqual(
        (obs.transactionResult as Record<string, unknown>).prototypeKeys,
      );
      expect(result.toJSON()).toEqual(
        (obs.transactionResult as Record<string, unknown>).toJSON,
      );
      expect(typeof result.toJSON).toBe(
        (obs.transactionResult as Record<string, unknown>).toJSONType,
      );
      const direct = new (constructor as new () => object)();
      expect({
        threw: false,
        constructorName: direct.constructor.name,
        ownKeys: Object.keys(direct).sort(),
      }).toEqual((obs.directConstruction as Record<string, unknown>).TransactionResult);
    });
  });

  describe('multiple database instances', () => {
    it('rtdb-modular#MI1 an app opens each instance once, and needs a URL or a project id', async () => {
      const sdk = (load('rtdb-modular-multiple-instances.json') as { sdk: Record<string, unknown> }).sdk;
      const app = createAppForSandbox(initializeSandbox(), { projectId: 'sdk-project' }, `mi1-sdk-${Math.random()}`);
      const noProject = createAppForSandbox(initializeSandbox(), { apiKey: 'unused' }, `mi1-sdk-none-${Math.random()}`);
      const outcome = (run: () => unknown) => {
        try {
          const value = run();
          return { value: typeof value === 'string' ? value : 'returned' };
        } catch (error) {
          return { error: (error as Error).message };
        }
      };
      try {
        getDatabase(app);
        const second = getDatabase(app, 'https://second.firebaseio.com');
        expect({
          sameArgumentSameHandle: getDatabase(app, 'https://second.firebaseio.com') === second,
          defaultUrlAfterDefault: outcome(() => getDatabase(app, 'https://sdk-project-default-rtdb.firebaseio.com')),
          trailingSlashAfterOpen: outcome(() => getDatabase(app, 'https://second.firebaseio.com/')),
          noProjectNoUrl: outcome(() => getDatabase(noProject)),
        }).toEqual({
          sameArgumentSameHandle: sdk.sameArgumentSameHandle,
          defaultUrlAfterDefault: sdk.defaultUrlAfterDefault,
          trailingSlashAfterOpen: sdk.trailingSlashAfterOpen,
          noProjectNoUrl: sdk.noProjectNoUrl,
        });
      } finally {
        await deleteApp(app);
        await deleteApp(noProject);
      }
    });

    it('rtdb-modular#MI1 rtdb-modular#MI2 each instance keeps its own data and rules, and one user reaches both', async () => {
      const obs = load('rtdb-modular-multiple-instances.json') as {
        rules: { default: Record<string, unknown>; second: Record<string, unknown> };
        signedOut: Record<string, string>;
        isolation: Record<string, unknown>;
        signedIn: Record<string, string>;
        isolationAfterBothWrites: Record<string, unknown>;
      };
      const sandbox = initializeSandbox();
      const SECOND = 'https://second.firebaseio.com';
      // Production's root rules on both instances are `false`; the capture's
      // rules sit under a run-scoped key, here `run`.
      databaseModule.sandbox.setRules(getDatabase(sandbox), { rules: { '.read': false, '.write': false, run: obs.rules.default } });
      databaseModule.sandbox.setRules(getDatabase(sandbox, SECOND), { rules: { '.read': false, '.write': false, run: obs.rules.second } });
      const verdict = (operation: Promise<unknown>) => operation.then(() => 'ALLOW', () => 'DENY');
      const held = async (url: string | undefined, path: string) => (await get(ref(getAdminDatabase(sandbox, url), path))).val();
      const signedOut = sandbox.withAuth(null);
      expect({
        defaultWrite: await verdict(set(ref(getDatabase(signedOut), 'run/open/probe'), 'default')),
        secondWrite: await verdict(set(ref(getDatabase(signedOut, SECOND), 'run/open/probe'), 'second')),
      }).toEqual(obs.signedOut);
      expect({
        secondWriteReadOnSecond: await held(SECOND, 'run/open/probe'),
        secondWriteReadOnDefault: await held(undefined, 'run/open/probe'),
      }).toEqual(obs.isolation);
      const user = sandbox.withAuth({ uid: 'one-user' });
      const userDefault = getDatabase(user);
      const userSecond = getDatabase(user, SECOND);
      expect({
        defaultWrite: await verdict(set(ref(userDefault, 'run/open/probe'), 'default')),
        secondOwnUserPath: await verdict(set(ref(userSecond, 'run/users/one-user'), 'own')),
        secondOtherUserPath: await verdict(set(ref(userSecond, 'run/users/another-user'), 'other')),
        secondPathWithoutRules: await verdict(get(ref(userSecond, 'run/closed'))),
        defaultReadOfSecondOnlyPath: await verdict(get(ref(userDefault, 'run/users/one-user'))),
      }).toEqual(obs.signedIn);
      expect({
        defaultHolds: await held(undefined, 'run/open/probe'),
        secondHolds: await held(SECOND, 'run/open/probe'),
        secondUserPathOnDefault: await held(undefined, 'run/users/one-user'),
      }).toEqual(obs.isolationAfterBothWrites);
    });
  });
});
