export const probe = {
  name: 'functions-rtdb-onvaluecreated-wildcard-batches',
  matrixRow: 'functions-rtdb #4, #5, #7, #13',
  rowIds: ['functions-rtdb#4', 'functions-rtdb#5', 'functions-rtdb#7', 'functions-rtdb#13'],
  description:
    'Named wildcards are captured for one child, an ancestor fan-out, a multi-location update, and three sequential creates whose arrival order is recorded without making it a guarantee.',
  rootPath(runId: string): string {
    return `/pyric_oracle/functions/${runId}/wildcard`;
  },
  cases: {
    single: { itemA: { marker: 'single' } },
    fanout: { alpha: { marker: 'fanout-a' }, beta: { marker: 'fanout-b' } },
    multipath: { gamma: { marker: 'multi-a' }, delta: { marker: 'multi-b' } },
    ordering: [1, 2, 3],
  },
  behavior(captures: Record<string, any>[]) {
    const byCase = (caseId: string) => captures.filter((capture) => capture.event.params.caseId === caseId);
    const single = byCase('single');
    const fanout = byCase('fanout');
    const multipath = byCase('multipath');
    const ordering = byCase('ordering');
    return {
      single: {
        deliveryCount: single.length,
        params: single[0]
          ? {
              caseId: single[0].event.params.caseId,
              itemId: single[0].event.params.itemId,
              runIdPresent: typeof single[0].event.params.runId === 'string',
            }
          : null,
        value: single[0]?.snapshot.val ?? null,
      },
      fanout: {
        deliveryCount: fanout.length,
        itemIds: fanout.map((capture) => capture.event.params.itemId).sort(),
        values: fanout.map((capture) => capture.snapshot.val.marker).sort(),
      },
      multipath: {
        deliveryCount: multipath.length,
        itemIds: multipath.map((capture) => capture.event.params.itemId).sort(),
        values: multipath.map((capture) => capture.snapshot.val.marker).sort(),
      },
      ordering: {
        deliveryCount: ordering.length,
        observedArrival: ordering.map((capture) => capture.snapshot.val.sequence),
        guaranteed: false,
      },
    };
  },
};
