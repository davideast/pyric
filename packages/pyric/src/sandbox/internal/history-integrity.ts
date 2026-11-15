import { SandboxError } from '../types/errors.js';

interface GapTotals {
  gapCount: number;
  omittedOperations: number;
  omittedDenials: number;
  hasTrackedDenials: boolean;
  hasUntrackedDenials: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

function collectGapTotals(events: readonly unknown[]): GapTotals {
  const totals: GapTotals = {
    gapCount: 0,
    omittedOperations: 0,
    omittedDenials: 0,
    hasTrackedDenials: false,
    hasUntrackedDenials: false,
  };
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.kind !== 'observation_gap') continue;
    totals.gapCount += 1;
    const omittedCount = readNonNegativeCount(event, 'omittedCount');
    if (omittedCount !== undefined) totals.omittedOperations += omittedCount;
    const omittedDenials = readNonNegativeCount(event, 'omittedDenials');
    if (omittedDenials === undefined) {
      totals.hasUntrackedDenials = true;
    } else {
      totals.hasTrackedDenials = true;
      totals.omittedDenials += omittedDenials;
    }
  }
  return totals;
}

function pluralize(count: number, singular: string, plural: string): string {
  if (count === 1) return singular;
  return plural;
}

function formatDenialsSummary(totals: GapTotals): string {
  const word = pluralize(totals.omittedDenials, 'denial', 'denials');
  if (!totals.hasUntrackedDenials) {
    return `${totals.omittedDenials} omitted ${word}`;
  }
  if (!totals.hasTrackedDenials) {
    return 'unknown omitted denials';
  }
  return `at least ${totals.omittedDenials} omitted ${word}`;
}

/** A retained suffix cannot stand in for a complete replay or verification input. */
export function assertCompleteHistory(events: readonly unknown[]): void {
  const totals = collectGapTotals(events);
  if (totals.gapCount === 0) return;
  const operationWord = pluralize(totals.omittedOperations, 'operation', 'operations');
  const denialsSummary = formatDenialsSummary(totals);
  throw new SandboxError(
    'failed-precondition',
    `Cannot replay or verify incomplete observation history (${totals.omittedOperations} omitted ${operationWord}, ${denialsSummary}). Inspect retained denials with \`pyric serve denials\` or capture a fresh session without observation gaps.`,
  );
}
