import { readFileSync } from 'node:fs';

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
