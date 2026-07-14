export const probe = {
  name: 'functions-rtdb-onvaluecreated-startup-existing',
  matrixRow: 'functions-rtdb #3',
  rowIds: ['functions-rtdb#3'],
  description:
    'A value created before the production trigger is deployed remains present but is not replayed as an onValueCreated event.',
  inputPath(runId: string): string {
    return `/pyric_oracle/functions/${runId}/startup/target`;
  },
  inputValue: { existedBeforeDeploy: true },
  behavior(deliveryCount: number, value: unknown, observationWindowMs: number) {
    return { deliveryCount, value, observationWindowMs };
  },
};
