const ERROR_MARKER = 'PYRIC_EXPECTED_ONVALUECREATED_FAILURE';

export const probe = {
  name: 'functions-rtdb-onvaluecreated-failed-execution',
  matrixRow: 'functions-rtdb #12',
  rowIds: ['functions-rtdb#12'],
  description:
    'A production onValueCreated async handler throws a marker error and the managed runtime emits an error-level execution record containing that marker.',
  inputPath(runId: string): string {
    return `/pyric_oracle/functions/${runId}/failure/target`;
  },
  inputValue: { shouldFail: true },
  errorMarker: ERROR_MARKER,
  behavior(
    handlerCaptureCount: number,
    outcome: { matchingRuntimeErrorCount: number; requestStatuses: number[] },
  ) {
    return {
      deliveryCount: handlerCaptureCount,
      runtimeErrorReported: outcome.matchingRuntimeErrorCount > 0,
      matchingRuntimeErrorCount: outcome.matchingRuntimeErrorCount,
      errorMarker: ERROR_MARKER,
      requestStatuses: outcome.requestStatuses,
    };
  },
};
