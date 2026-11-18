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
} from '../../../../conformance/src/firestore-query-construction-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore Query construction oracle captures (in-page pyric/firestore)', () => {
  it('firestore-query-compose-where-orderby-limit (firestore#54)', async () => {
    const production = load('firestore-query-compose-where-orderby-limit');
    const pyric = await replayQueryComposeWhereOrderByLimit(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-where-ten-filter-operators (firestore#55)', async () => {
    const production = stripCaptureTransport(load('firestore-where-ten-filter-operators'));
    const pyric = await replayWhereTenFilterOperators(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-where-existence-and-null-guards (firestore#55a)', async () => {
    const production = stripCaptureTransport(load('firestore-where-existence-and-null-guards'));
    const pyric = await replayWhereExistenceAndNullGuards(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-direction-asc-desc (firestore#59)', async () => {
    const production = load('firestore-orderby-direction-asc-desc');
    const pyric = await replayOrderByDirectionAscDesc(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-canonical-type-order (firestore#59a)', async () => {
    const production = load('firestore-orderby-canonical-type-order');
    const pyric = await replayOrderByCanonicalTypeOrder(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-excludes-missing-field (firestore#59b)', async () => {
    const production = load('firestore-orderby-excludes-missing-field');
    const pyric = await replayOrderByExcludesMissingField(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-orderby-implicit-inequality-and-name-tiebreak (firestore#59c)', async () => {
    const production = load('firestore-orderby-implicit-inequality-and-name-tiebreak');
    const pyric = await replayOrderByImplicitInequalityAndNameTiebreak(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-limit-caps-result-count (firestore#60)', async () => {
    const production = load('firestore-limit-caps-result-count');
    const pyric = await replayLimitCapsResultCount(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-or-with-orderby-and-limit (firestore#62)', async () => {
    const production = load('firestore-composite-or-with-orderby-and-limit');
    const pyric = await replayCompositeOrWithOrderByAndLimit(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-rejects-nonfilter-constraints (firestore#63)', () => {
    const production = load('firestore-composite-rejects-nonfilter-constraints');
    const pyric = replayCompositeRejectsNonFilterConstraints(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-composite-zero-arg-or-and (firestore#64)', async () => {
    const production = load('firestore-composite-zero-arg-or-and');
    const pyric = await replayCompositeZeroArgOrAnd(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-query-chaining-retags-constraints (firestore#65)', async () => {
    const production = load('firestore-query-chaining-retags-constraints');
    const pyric = await replayQueryChainingRetagsConstraints(inPageContext());
    expectReplay({ production, pyric });
  });
});
