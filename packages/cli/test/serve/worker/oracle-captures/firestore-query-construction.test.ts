import { describe, it } from 'bun:test';
import {
  replayCompositeOrWithOrderByAndLimit,
  replayCompositeRejectsNonFilterConstraints,
  replayCompositeZeroArgOrAnd,
  replayLimitCapsResultCount,
  replayOrderByCanonicalTypeOrder,
  replayOrderByDirectionAscDesc,
  replayOrderByExcludesMissingField,
  replayOrderByImplicitInequalityAndNameTiebreak,
  replayQueryChainingRetagsConstraints,
  replayQueryComposeWhereOrderByLimit,
  replayWhereExistenceAndNullGuards,
  replayWhereTenFilterOperators,
  stripCaptureTransport,
} from '../../../../../conformance/src/firestore-query-construction-replay.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

describe('Firestore Query construction oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('firestore-query-compose-where-orderby-limit (firestore#54)', async () => {
    const production = load('firestore-query-compose-where-orderby-limit');
    const pyric = await replayQueryComposeWhereOrderByLimit(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-where-ten-filter-operators (firestore#55)', async () => {
    const production = stripCaptureTransport(load('firestore-where-ten-filter-operators'));
    const pyric = await replayWhereTenFilterOperators(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-where-existence-and-null-guards (firestore#55a)', async () => {
    const production = stripCaptureTransport(load('firestore-where-existence-and-null-guards'));
    const pyric = await replayWhereExistenceAndNullGuards(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-direction-asc-desc (firestore#59)', async () => {
    const production = load('firestore-orderby-direction-asc-desc');
    const pyric = await replayOrderByDirectionAscDesc(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-canonical-type-order (firestore#59a)', async () => {
    const production = load('firestore-orderby-canonical-type-order');
    const pyric = await replayOrderByCanonicalTypeOrder(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-excludes-missing-field (firestore#59b)', async () => {
    const production = load('firestore-orderby-excludes-missing-field');
    const pyric = await replayOrderByExcludesMissingField(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-implicit-inequality-and-name-tiebreak (firestore#59c)', async () => {
    const production = load('firestore-orderby-implicit-inequality-and-name-tiebreak');
    const pyric = await replayOrderByImplicitInequalityAndNameTiebreak(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-limit-caps-result-count (firestore#60)', async () => {
    const production = load('firestore-limit-caps-result-count');
    const pyric = await replayLimitCapsResultCount(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-or-with-orderby-and-limit (firestore#62)', async () => {
    const production = load('firestore-composite-or-with-orderby-and-limit');
    const pyric = await replayCompositeOrWithOrderByAndLimit(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-rejects-nonfilter-constraints (firestore#63)', async () => {
    const production = load('firestore-composite-rejects-nonfilter-constraints');
    const pyric = replayCompositeRejectsNonFilterConstraints(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-zero-arg-or-and (firestore#64)', async () => {
    const production = load('firestore-composite-zero-arg-or-and');
    const pyric = await replayCompositeZeroArgOrAnd(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-query-chaining-retags-constraints (firestore#65)', async () => {
    const production = load('firestore-query-chaining-retags-constraints');
    const pyric = await replayQueryChainingRetagsConstraints(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });
});
