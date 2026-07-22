export const STORAGE_PROBE_LIMITS = {
  storage: 40,
  firestoreWrite: 25,
  rules: 20,
  iam: 12,
} as const;

// Cleanup has an independent bounded reserve so an unexpected ALLOW result
// cannot spend the requests required to remove the resources it created.
export const STORAGE_CLEANUP_LIMITS = {
  storage: 20,
  firestoreWrite: 12,
  rules: 4,
  iam: 2,
} as const;

export type BudgetKind = 'storage' | 'firestoreWrite' | 'rules' | 'iam';

export class RequestBudget {
  readonly counts: Record<BudgetKind, number> = {
    storage: 0,
    firestoreWrite: 0,
    rules: 0,
    iam: 0,
  };

  constructor(readonly limits: Record<BudgetKind, number>) {}

  take(kind: BudgetKind, amount = 1): void {
    const next = this.counts[kind] + amount;
    if (next > this.limits[kind]) {
      throw new Error(`${kind} request budget exceeded: ${next} > ${this.limits[kind]}`);
    }
    this.counts[kind] = next;
  }

  snapshot(): { counts: Record<BudgetKind, number>; limits: Record<BudgetKind, number> } {
    return { counts: { ...this.counts }, limits: { ...this.limits } };
  }
}

export async function runCleanupSteps(
  steps: Array<{ label: string; run: () => Promise<void> }>,
): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`${step.label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'real-resource cleanup failed');
}
