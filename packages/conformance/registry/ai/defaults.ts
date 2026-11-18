export const AI_CLIMB_SUITE = 'packages/pyric/test/ai';

export function expandAiClimbTest(file: string): string {
  return `${AI_CLIMB_SUITE}/${file}`;
}

export const ENGINE_EXCEPTION = 'answer-engine seam; no production counterpart to observe';

export const ENGINE_NOTE =
  'The engine seam has no production analogue; sandbox-only per packages/conformance/docs/ai/cdd-deltas.md.';

export const ERROR_RISK = {
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
};
