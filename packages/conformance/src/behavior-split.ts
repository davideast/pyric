import type { CompatibilityRow } from '../registry/types.ts';

type BehaviorEvidenceRow = Pick<
  CompatibilityRow,
  'status' | 'automation' | 'oracleObservations' | 'risk'
>;

interface ConformingEvidenceSplit {
  conforms: number;
  captureProven: number;
  selfTested: number;
}

export function isCaptureProvenRow(row: BehaviorEvidenceRow): boolean {
  return (
    row.status === 'conforms' &&
    row.automation === 'oracle-backed' &&
    row.oracleObservations.length > 0 &&
    !row.risk.includes('cited-not-replayed')
  );
}

export function isSelfTestedOnlyRow(row: BehaviorEvidenceRow): boolean {
  return row.status === 'conforms' && !isCaptureProvenRow(row);
}

export function splitConformingRows(rows: readonly BehaviorEvidenceRow[]): ConformingEvidenceSplit {
  let captureProven = 0;
  let selfTested = 0;
  for (const row of rows) {
    if (isCaptureProvenRow(row)) {
      captureProven += 1;
    } else if (isSelfTestedOnlyRow(row)) {
      selfTested += 1;
    }
  }
  return {
    conforms: captureProven + selfTested,
    captureProven,
    selfTested,
  };
}

export function formatPageBehaviorNote(rows: readonly BehaviorEvidenceRow[]): string {
  const { captureProven, selfTested } = splitConformingRows(rows);
  const total = rows.length;
  return `Behavior rows: ${captureProven} of ${total} proven by a Firebase capture; ${selfTested} of ${total} pass Pyric's own tests only.`;
}

export function formatScoreboardBehaviorBasis(rows: readonly BehaviorEvidenceRow[]): string {
  const { captureProven, selfTested } = splitConformingRows(rows);
  const total = rows.length;
  return `${captureProven} of ${total} proven by a Firebase capture; ${selfTested} of ${total} pass Pyric's own tests only`;
}

function formatConformingFidelityQualifier(captureProven: number, selfTested: number): string {
  if (captureProven > 0 && selfTested > 0) {
    return `${captureProven} proven by a Firebase capture, ${selfTested} passing Pyric's own tests only`;
  }
  if (selfTested > 0) {
    return "passes Pyric's own tests only";
  }
  return 'proven by a Firebase capture';
}

export function formatFidelityClause(fidelity: string, captureProven: number, selfTested: number): string {
  if (fidelity === 'not-applicable') return 'has no applicable behavior claim';
  if (fidelity === 'conforms') {
    return `has conforms fidelity (${formatConformingFidelityQualifier(captureProven, selfTested)})`;
  }
  return `has ${fidelity} fidelity`;
}
