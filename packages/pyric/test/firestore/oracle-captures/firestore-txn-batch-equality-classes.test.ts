import { describe, it } from 'bun:test';
import {
  replayRefEqualAndAggregateEquality,
  replayRuntimeClassesAndInstanceOf,
  replayTransactionAndBatchQueuedMutations,
} from '../../../../conformance/src/firestore-txn-batch-equality-classes-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore transaction, batch, equality, server reads, and runtime classes oracle captures (in-page pyric/firestore)', () => {
  it('firestore-transaction-and-batch-queued-mutations (firestore#91, #95)', async () => {
    const production = load('firestore-transaction-and-batch-queued-mutations');
    const ctx = inPageContext();
    try {
      const pyric = await replayTransactionAndBatchQueuedMutations(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-refequal-and-aggregate-equality (firestore#112, #114, #118, #147, #155)', async () => {
    const production = load('firestore-refequal-and-aggregate-equality');
    const ctx = inPageContext();
    try {
      const pyric = await replayRefEqualAndAggregateEquality(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-runtime-classes-and-instanceof (firestore#151)', async () => {
    const production = load('firestore-runtime-classes-and-instanceof');
    const ctx = inPageContext();
    try {
      const pyric = await replayRuntimeClassesAndInstanceOf(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });
});
