import { existsSync, readFileSync } from 'node:fs';
import type { Probe } from '../rigs/types.ts';

export interface ObservationLinkage {
  matrixRow: string;
  rowIds: string[];
}

export function observationLinkageOf(value: unknown): ObservationLinkage {
  if (!value || typeof value !== 'object') return { matrixRow: '', rowIds: [] };
  const record = value as Record<string, unknown>;
  return {
    matrixRow: typeof record.matrixRow === 'string' ? record.matrixRow : '',
    rowIds: Array.isArray(record.rowIds)
      ? record.rowIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export function readObservationLinkage(path: string): ObservationLinkage {
  try {
    return observationLinkageOf(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { matrixRow: '', rowIds: [] };
    }
    throw error;
  }
}

export function resolveProbeObservationLinkage(
  probe: Pick<Probe, 'matrixRow' | 'rowIds'>,
  observationPath: string,
): ObservationLinkage {
  const existing = readObservationLinkage(observationPath);
  let matrixRow = existing.matrixRow;
  if (probe.matrixRow !== '') {
    matrixRow = probe.matrixRow;
  }
  let rowIds = existing.rowIds;
  if (probe.rowIds.length > 0) {
    rowIds = [...probe.rowIds];
  }
  return { matrixRow, rowIds };
}

export function shouldIncludeProbeInUnfilteredRun(
  probe: Pick<Probe, 'pendingRowLink'>,
  observationPath: string,
): boolean {
  if (probe.pendingRowLink === true && !existsSync(observationPath)) {
    return false;
  }
  return true;
}
