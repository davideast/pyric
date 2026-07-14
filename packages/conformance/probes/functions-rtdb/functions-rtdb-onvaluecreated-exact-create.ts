/**
 * Production capture scenario for functions-rtdb#1, #2, and #8–#11. The credentialed harness
 * supplies the run id and owns deployment/log transport; this record owns the
 * input and the observation projection so the probe and frozen evidence cannot
 * drift into two independently-authored scenarios.
 */
export const probe = {
  name: 'functions-rtdb-onvaluecreated-exact-create',
  matrixRow: 'functions-rtdb #1, #2, #8, #9, #10, #11',
  rowIds: [
    'functions-rtdb#1',
    'functions-rtdb#2',
    'functions-rtdb#8',
    'functions-rtdb#9',
    'functions-rtdb#10',
    'functions-rtdb#11',
  ],
  description:
    'An exact production onValueCreated trigger captures create-only delivery, the event and DataSnapshot shape, Admin ref behavior, writer context, and awaited handler completion.',
  inputPath(runId: string): string {
    return `/pyric_oracle/functions/${runId}/exact/target`;
  },
  inputValue: {
    hello: 'functions',
    count: 1,
    nested: { enabled: true },
    items: { alpha: 1, beta: 2 },
  },
  behavior(
    captures: Record<string, any>[],
    handlerWrite: unknown,
  ): Record<string, unknown> {
    const capture = captures[0];
    const event = capture.event;
    return {
      deliveryCount: captures.length,
      createOnlyAfterUpdateAndDelete: captures.length === 1,
      event: {
        idPresent: event.idPresent,
        type: event.type,
        timePresent: event.timePresent,
        instance: event.instance,
        location: event.location,
        refMatchesRunId: event.ref.includes(`/functions/${capture.runId}/exact/target`),
        subjectMatchesRef: event.subject === `refs/${event.ref}`,
        params: { runIdPresent: typeof event.params.runId === 'string' && event.params.runId.length > 0 },
        authType: event.authType,
        authId: event.authId,
      },
      snapshot: capture.snapshot,
      handler: capture.handler,
      handlerWrite,
    };
  },
};
