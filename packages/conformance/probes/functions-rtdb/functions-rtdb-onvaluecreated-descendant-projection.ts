export const probe = {
  name: 'functions-rtdb-onvaluecreated-descendant-projection',
  matrixRow: 'functions-rtdb #6',
  rowIds: ['functions-rtdb#6'],
  description:
    'Writing an ancestor object creates the exact matched leaf, whose event snapshot contains only the descendant value.',
  ancestorPath(runId: string): string {
    return `/pyric_oracle/functions/${runId}/descendant`;
  },
  inputValue: { leaf: { projected: true }, sibling: { excluded: true } },
  behavior(capture: Record<string, any>) {
    return {
      deliveryCount: 1,
      key: capture.snapshot.key,
      val: capture.snapshot.val,
      siblingExcluded: capture.snapshot.val?.sibling === undefined,
      event: {
        type: capture.event.type,
        refMatchesRunId: capture.event.ref.includes(
          `/functions/${capture.runId}/descendant/leaf`,
        ),
        runIdPresent: typeof capture.event.params.runId === 'string',
      },
    };
  },
};
