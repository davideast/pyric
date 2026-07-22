/** Focused real-Firebase oracle replay: runtime identity. */
import { describe, it, expect } from 'bun:test';
import * as databaseModule from '../../../src/database/index.js';
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

});
