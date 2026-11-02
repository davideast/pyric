/**
 * How the hourly check's gates add up. A check passes only when every gate
 * ran and passed: a gate that could not run (the walks, when Studio did not
 * start) fails the check like one that ran and failed.
 */
export const GATES = ['typecheck', 'tests', 'studio-checks', 'app-start', 'walks', 'ui-rules', 'copy', 'layout'] as const;

export type GateName = (typeof GATES)[number];

export interface GateResult {
  gate: GateName;
  passed: boolean;
  /** One line: what passed, or what failed. */
  summary: string;
  /** The failing output, written to `<gate>.log` in the check's folder. */
  output?: string;
  /** How the gate's last command ended: a null code without a timeout is a signal. */
  exit?: { code: number | null; timedOut: boolean };
}

export interface Composed {
  passed: boolean;
  summary: string;
  failed: GateName[];
}

export function skipped(gate: GateName, why: string): GateResult {
  return { gate, passed: false, summary: `did not run: ${why}` };
}

export function composeGates(results: readonly GateResult[], expected: readonly GateName[] = GATES): Composed {
  const byGate = new Map(results.map((result) => [result.gate, result]));
  const failed = expected.filter((gate) => byGate.get(gate)?.passed !== true);
  const notes = failed.map((gate) => `${gate} (${byGate.get(gate)?.summary ?? 'did not run'})`);
  const passed = failed.length === 0;
  const summary = passed ? `all ${expected.length} gates passed` : `${failed.length} of ${expected.length} gates failed: ${notes.join('; ')}`;
  return { passed, summary, failed };
}
