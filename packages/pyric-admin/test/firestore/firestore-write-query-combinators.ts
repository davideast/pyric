/**
 * Generative argument combinators for Admin Firestore writes (`FieldValue`,
 * `DocumentData`, `SetOptions`, `Precondition`), `update`, `Query`, `WriteBatch`,
 * and `runTransaction`.
 */

import {
  emitTypeWrongnessCandidates,
  makeCandidate,
  type CandidateValue,
} from '../argument-generator/argument-combinators.js';
import type {
  FirestoreDialectRuntime,
  FirestoreDifferentialCase,
} from './firestore-combinators.js';

class CustomBox {
  readonly tag = 'box';
}

export function emitFieldValueAndWriteCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [
    {
      label: 'FieldValue.increment(0-args)',
      invoke: (rt) => rt.FieldValue.increment(),
    },
    {
      label: 'FieldValue.arrayUnion(0-args)',
      invoke: (rt) => rt.FieldValue.arrayUnion(),
    },
    {
      label: 'FieldValue.arrayRemove(0-args)',
      invoke: (rt) => rt.FieldValue.arrayRemove(),
    },
  ];

  const incrementCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('neg-float', () => -1.5),
    makeCandidate('neg-zero', () => -0),
    makeCandidate('pos-inf', () => Number.POSITIVE_INFINITY),
    makeCandidate('neg-inf', () => Number.NEGATIVE_INFINITY),
  ];
  for (const cand of incrementCandidates) {
    cases.push({
      label: `set:FieldValue.increment(${cand.label})`,
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ count: rt.FieldValue.increment(cand.build()) }),
    });
  }

  for (const method of ['arrayUnion', 'arrayRemove'] as const) {
    for (const cand of emitTypeWrongnessCandidates()) {
      cases.push({
        label: `set:FieldValue.${method}(${cand.label})`,
        invoke: (rt) =>
          rt.db.doc(rt.existingDocPath).set({ tags: rt.FieldValue[method](cand.build()) }),
      });
    }
    cases.push(
      {
        label: `set:FieldValue.${method}(nested-array)`,
        invoke: (rt) =>
          rt.db.doc(rt.existingDocPath).set({ tags: rt.FieldValue[method]([1]) }),
      },
      {
        label: `set:FieldValue.${method}(serverTimestamp)`,
        invoke: (rt) =>
          rt.db
            .doc(rt.existingDocPath)
            .set({ tags: rt.FieldValue[method](rt.FieldValue.serverTimestamp()) }),
      },
      {
        label: `set:FieldValue.${method}(increment)`,
        invoke: (rt) =>
          rt.db
            .doc(rt.existingDocPath)
            .set({ tags: rt.FieldValue[method](rt.FieldValue.increment(1)) }),
      },
      {
        label: `set:FieldValue.${method}(delete)`,
        invoke: (rt) =>
          rt.db
            .doc(rt.existingDocPath)
            .set({ tags: rt.FieldValue[method](rt.FieldValue.delete()) }),
      },
      {
        label: `set:FieldValue.${method}(FieldPath)`,
        invoke: (rt) =>
          rt.db
            .doc(rt.existingDocPath)
            .set({ tags: rt.FieldValue[method](new rt.FieldPath('x')) }),
      },
      {
        label: `set:FieldValue.${method}(custom-class)`,
        invoke: (rt) =>
          rt.db.doc(rt.existingDocPath).set({ tags: rt.FieldValue[method](new CustomBox()) }),
      },
      {
        label: `set:FieldValue.${method}(docRef+bytes+ts+date)`,
        invoke: (rt) =>
          rt.db.doc(rt.existingDocPath).set({
            tags: rt.FieldValue[method](
              rt.db.doc('items/ref1'),
              new Uint8Array([1, 2]),
              new rt.Timestamp(10, 0),
              new Date(0),
            ),
          }),
      },
    );
  }

  // Root DocumentData container candidates across set, create, add
  const rootDataCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('Map', () => new Map([['a', 1]])),
    makeCandidate('Date', () => new Date(0)),
    makeCandidate('CustomBox', () => new CustomBox()),
    makeCandidate('null-proto-with-field', () => {
      const obj = Object.create(null) as Record<string, unknown>;
      obj.title = 'ok';
      return obj;
    }),
  ];
  for (const cand of rootDataCandidates) {
    cases.push({
      label: `doc.set(data=${cand.label})`,
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set(cand.build()),
    });
    cases.push({
      label: `doc.create(data=${cand.label})`,
      invoke: (rt) => rt.db.doc(rt.nextAbsentDocPath()).create(cand.build()),
    });
    cases.push({
      label: `col.add(data=${cand.label})`,
      invoke: (rt) => rt.db.collection('items').add(cand.build()),
    });
  }

  // Document field value & sentinel placement boundaries
  const payloadShapes: Array<{ label: string; build: (rt: FirestoreDialectRuntime) => unknown }> = [
    { label: 'top-undefined', build: () => ({ a: undefined }) },
    { label: 'nested-undefined', build: () => ({ nested: { b: undefined } }) },
    { label: 'array-undefined', build: () => ({ arr: [undefined] }) },
    { label: 'function-val', build: () => ({ fn: () => 1 }) },
    { label: 'symbol-val', build: () => ({ sym: Symbol('s') }) },
    { label: 'bigint-val', build: () => ({ big: 1n }) },
    { label: 'FieldPath-val', build: (rt) => ({ fp: new rt.FieldPath('a') }) },
    { label: 'custom-class-val', build: () => ({ box: new CustomBox() }) },
    { label: 'invalid-Date', build: () => ({ dt: new Date(Number.NaN) }) },
    { label: 'valid-Date', build: () => ({ dt: new Date(1000) }) },
    { label: 'invalid-Timestamp', build: (rt) => ({ ts: new rt.Timestamp(1, -1) }) },
    { label: 'valid-Timestamp', build: (rt) => ({ ts: new rt.Timestamp(1, 0) }) },
    { label: 'valid-Uint8Array', build: () => ({ raw: new Uint8Array([7, 8]) }) },
    { label: 'valid-DocRef', build: (rt) => ({ ref: rt.db.doc('items/other') }) },
    { label: 'empty-key-top', build: () => ({ '': 1 }) },
    { label: 'empty-key-nested', build: () => ({ nested: { '': 1 } }) },
    { label: 'nested-array', build: () => ({ arr: [[1]] }) },
    { label: 'nested-array-in-map-in-array', build: () => ({ arr: [{ inner: [[1]] }] }) },
    { label: 'serverTimestamp-in-array', build: (rt) => ({ arr: [rt.FieldValue.serverTimestamp()] }) },
    { label: 'increment-in-array', build: (rt) => ({ arr: [rt.FieldValue.increment(1)] }) },
    { label: 'delete-in-array', build: (rt) => ({ arr: [rt.FieldValue.delete()] }) },
    { label: 'delete-top-no-merge', build: (rt) => ({ title: rt.FieldValue.delete() }) },
    { label: 'user-map-__type-deleteField', build: () => ({ meta: { __type: 'deleteField' } }) },
    { label: 'user-map-__type-increment', build: () => ({ meta: { __type: 'increment', value: 'v1' } }) },
    { label: 'user-map-__type-serverTimestamp', build: () => ({ meta: { __type: 'serverTimestamp' } }) },
    { label: 'root-__type-deleteField', build: () => ({ __type: 'deleteField' }) },
  ];
  for (const shape of payloadShapes) {
    cases.push({
      label: `doc.set(${shape.label})`,
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set(shape.build(rt)),
    });
    cases.push({
      label: `doc.create(${shape.label})`,
      invoke: (rt) => rt.db.doc(rt.nextAbsentDocPath()).create(shape.build(rt)),
    });
    cases.push({
      label: `col.add(${shape.label})`,
      invoke: (rt) => rt.db.collection('items').add(shape.build(rt)),
    });
  }

  // FieldValue.delete() with SetOptions variations
  cases.push(
    {
      label: 'doc.set(delete, {merge:false})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: rt.FieldValue.delete() }, { merge: false }),
    },
    {
      label: 'doc.set(top-delete, {merge:true})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: rt.FieldValue.delete() }, { merge: true }),
    },
    {
      label: 'doc.set(nested-delete, {merge:true})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ nested: { flag: rt.FieldValue.delete() } }, { merge: true }),
    },
    {
      label: 'doc.set(delete-in-array, {merge:true})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ arr: [rt.FieldValue.delete()] }, { merge: true }),
    },
    {
      label: 'doc.set(nested-delete, {mergeFields:["nested.flag"]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ nested: { flag: rt.FieldValue.delete() } }, { mergeFields: ['nested.flag'] }),
    },
    {
      label: 'doc.set(unmasked-delete, {mergeFields:["title"]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ title: 'kept', other: rt.FieldValue.delete() }, { mergeFields: ['title'] }),
    },
  );

  // SetOptions combinations on doc.set
  for (const optCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `doc.set(options=${optCand.label})`,
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set({ title: 'v' }, optCand.build()),
    });
    cases.push({
      label: `doc.set({merge:${optCand.label}})`,
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { merge: optCand.build() }),
    });
    cases.push({
      label: `doc.set({mergeFields:${optCand.label}})`,
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: optCand.build() }),
    });
  }

  cases.push(
    {
      label: 'doc.set({merge:true, mergeFields:["title"]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ title: 'v' }, { merge: true, mergeFields: ['title'] }),
    },
    {
      label: 'doc.set({merge:false, mergeFields:["title"]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ title: 'v' }, { merge: false, mergeFields: ['title'] }),
    },
    {
      label: 'doc.set({merge:undefined, mergeFields:["title"]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ title: 'v' }, { merge: undefined, mergeFields: ['title'] }),
    },
    {
      label: 'doc.set({mergeFields:[]})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: [] }),
    },
    {
      label: 'doc.set({mergeFields:["title"]})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: ['title'] }),
    },
    {
      label: 'doc.set({mergeFields:[FieldPath("nested","flag")]})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set(
            { nested: { flag: false } },
            { mergeFields: [new rt.FieldPath('nested', 'flag')] },
          ),
    },
    {
      label: 'doc.set({mergeFields:["missing"]})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: ['missing'] }),
    },
    {
      label: 'doc.set({mergeFields:["a..b"]})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: ['a..b'] }),
    },
    {
      label: 'doc.set({mergeFields:[""]})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: [''] }),
    },
    {
      label: 'doc.set({mergeFields:[123]})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).set({ title: 'v' }, { mergeFields: [123] }),
    },
    {
      label: 'doc.set({mergeFields:["title","title"]} exact-dup)',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ title: 'v' }, { mergeFields: ['title', 'title'] }),
    },
    {
      label: 'doc.set({mergeFields:["nested","nested.flag"]} ancestor-descendant)',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ nested: { flag: true } }, { mergeFields: ['nested', 'nested.flag'] }),
    },
    {
      label: 'doc.set({mergeFields:["nested.flag","nested"]} descendant-ancestor)',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ nested: { flag: true } }, { mergeFields: ['nested.flag', 'nested'] }),
    },
    {
      label: 'doc.set({mergeFields:[FieldPath("a.b"),"a"]} literal-dot non-overlap)',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .set({ 'a.b': 1, a: { b: 2 } }, { mergeFields: [new rt.FieldPath('a.b'), 'a'] }),
    },
  );

  // doc.delete(precondition) validation
  cases.push({
    label: 'doc.delete(0-args)',
    invoke: (rt) => rt.db.doc('items/del-0').delete(),
  });
  for (const preCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `doc.delete(precondition=${preCand.label})`,
      invoke: (rt) => {
        if (preCand.label === 'undefined') {
          return rt.db.doc('items/del-undef').delete(undefined);
        }
        return rt.db.doc('items/del-cand').delete(preCand.build());
      },
    });
  }
  cases.push(
    {
      label: 'doc.delete({exists:"bad"})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).delete({ exists: 'bad' }),
    },
    {
      label: 'doc.delete({lastUpdateTime:"bad"})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).delete({ lastUpdateTime: 'bad' }),
    },
    {
      label: 'doc.delete({exists:true, lastUpdateTime:ts})',
      invoke: (rt) =>
        rt.db
          .doc(rt.existingDocPath)
          .delete({ exists: true, lastUpdateTime: rt.Timestamp.now() }),
    },
    {
      label: 'doc.delete({exists:true}) on existing',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).delete({ exists: true }),
    },
  );

  return cases;
}

export function emitUpdateCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [
    {
      label: 'doc.update(0-args)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update(),
    },
    {
      label: 'doc.update(missing-doc)',
      invoke: (rt) => rt.db.doc('items/nonexistent-doc').update({ count: 2 }),
    },
  ];

  // First-argument wrong-type + empty-object candidates
  for (const cand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `doc.update(first=${cand.label})`,
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update(cand.build()),
    });
  }

  cases.push(
    {
      label: 'doc.update(Map)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update(new Map([['count', 2]])),
    },
    {
      label: 'doc.update(CustomBox)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update(new CustomBox()),
    },
    {
      label: 'doc.update(null-proto-non-empty)',
      invoke: (rt) => {
        const map = Object.create(null) as Record<string, unknown>;
        map.count = 2;
        return rt.db.doc(rt.existingDocPath).update(map);
      },
    },
    {
      label: 'doc.update({count:2})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ count: 2 }),
    },
    {
      label: 'doc.update({"nested.flag":false})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ 'nested.flag': false }),
    },
    {
      label: 'doc.update({"":1})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ '': 1 }),
    },
    {
      label: 'doc.update({"a..b":1})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ 'a..b': 1 }),
    },
    {
      label: 'doc.update({".a":1})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ '.a': 1 }),
    },
    {
      label: 'doc.update({"a*b":1})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ 'a*b': 1 }),
    },
    {
      label: 'doc.update({a:undefined})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ a: undefined }),
    },
    {
      label: 'doc.update({nested:{b:undefined}})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ nested: { b: undefined } }),
    },
    {
      label: 'doc.update({title:FieldValue.delete()})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({ title: rt.FieldValue.delete() }),
    },
    {
      label: 'doc.update({"nested.flag":FieldValue.delete()})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({ 'nested.flag': rt.FieldValue.delete() }),
    },
    {
      label: 'doc.update({nested:{flag:FieldValue.delete()}})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({ nested: { flag: rt.FieldValue.delete() } }),
    },
    {
      label: 'doc.update({arr:[FieldValue.delete()]})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({ arr: [rt.FieldValue.delete()] }),
    },
    {
      label: 'doc.update(map-prefix-conflict a & a.b)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ a: 1, 'a.b': 2 }),
    },
    {
      label: 'doc.update(map-prefix-conflict a.b & a.b.c)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ 'a.b': 1, 'a.b.c': 2 }),
    },
    {
      label: 'doc.update(user-map __type collisions)',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({
          metaDel: { __type: 'deleteField' },
          metaInc: { __type: 'increment', value: 'v1' },
          metaTs: { __type: 'serverTimestamp' },
        }),
    },
    {
      label: 'doc.update(map-too-many-args)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ count: 2 }, {}, 'extra'),
    },
  );

  // Map-form trailing precondition shapes
  for (const preCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `doc.update({count:2}, pre=${preCand.label})`,
      invoke: (rt) => {
        if (preCand.label === 'undefined') {
          return rt.db.doc(rt.existingDocPath).update({ count: 2 }, undefined);
        }
        return rt.db.doc(rt.existingDocPath).update({ count: 2 }, preCand.build());
      },
    });
  }
  cases.push(
    {
      label: 'doc.update({count:2}, {exists:true})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ count: 2 }, { exists: true }),
    },
    {
      label: 'doc.update({count:2}, {exists:false})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ count: 2 }, { exists: false }),
    },
    {
      label: 'doc.update({count:2}, {exists:"bad"})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update({ count: 2 }, { exists: 'bad' }),
    },
    {
      label: 'doc.update({count:2}, {lastUpdateTime:"bad"})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update({ count: 2 }, { lastUpdateTime: 'bad' }),
    },
  );

  // Vararg form: odd/trailing args, FieldPath instances, deletes, duplicates & prefix conflicts
  cases.push(
    {
      label: 'doc.update("count")',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count'),
    },
    {
      label: 'doc.update(FieldPath("count"))',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update(new rt.FieldPath('count')),
    },
    {
      label: 'doc.update("count", 2)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 2),
    },
    {
      label: 'doc.update(FieldPath("nested","flag"), false)',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update(new rt.FieldPath('nested', 'flag'), false),
    },
    {
      label: 'doc.update("nested.flag", FieldValue.delete())',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update('nested.flag', rt.FieldValue.delete()),
    },
    {
      label: 'doc.update("nested", {flag: FieldValue.delete()})',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update('nested', { flag: rt.FieldValue.delete() }),
    },
    {
      label: 'doc.update("count", undefined)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', undefined),
    },
    {
      label: 'doc.update("a..b", 1)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('a..b', 1),
    },
    {
      label: 'doc.update("count", 2, 123, 4)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 2, 123, 4),
    },
    {
      label: 'doc.update("count", 2, "trailingField")',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 2, 'trailingField'),
    },
    {
      label: 'doc.update("count", 2, {exists:true})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 2, { exists: true }),
    },
    {
      label: 'doc.update("count", 2, {exists:false})',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 2, { exists: false }),
    },
    {
      label: 'doc.update(vararg duplicate "count", 1, "count", 2)',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('count', 1, 'count', 2),
    },
    {
      label: 'doc.update(vararg duplicate "a.b" & FieldPath("a","b"))',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update('a.b', 1, new rt.FieldPath('a', 'b'), 2),
    },
    {
      label: 'doc.update(vararg prefix conflict "a" & "a.b")',
      invoke: (rt) => rt.db.doc(rt.existingDocPath).update('a', 1, 'a.b', 2),
    },
    {
      label: 'doc.update(vararg non-conflict literal-dot FieldPath("a.b") & "a")',
      invoke: (rt) =>
        rt.db.doc(rt.existingDocPath).update(new rt.FieldPath('a.b'), 1, 'a', 2),
    },
  );

  return cases;
}
