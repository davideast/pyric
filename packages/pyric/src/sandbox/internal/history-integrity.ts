import { SandboxError } from '../types/errors.js';

/** A retained suffix cannot stand in for a complete replay or verification input. */
export function assertCompleteHistory(events: readonly unknown[]): void {
  const hasGap = events.some(event => {
    const isRecord = event !== null && typeof event === 'object';
    const isGap = isRecord && 'kind' in event && event.kind === 'observation_gap';
    return isGap;
  });
  if (hasGap) throw new SandboxError('failed-precondition',
    'Cannot replay or verify incomplete observation history. Capture a fresh session without observation gaps.');
}
