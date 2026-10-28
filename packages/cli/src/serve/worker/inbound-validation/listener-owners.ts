import { requireRecord, requireShape, requireString, requireOptionalString } from './fields.js';

function requireStringList(value: unknown, field: string): void {
  const isList = Array.isArray(value) && value.every(item => typeof item === 'string');
  requireShape(isList, field);
}

/** One stack position: a file, a finite line, and optionally a column and function name. */
function requireFramePosition(value: Record<string, unknown>, field: string): void {
  requireString(value.file, `${field}.file`);
  const hasLine = typeof value.line === 'number' && Number.isFinite(value.line);
  requireShape(hasLine, `${field}.line`);
  const hasColumn = value.column === undefined || typeof value.column === 'number' && Number.isFinite(value.column);
  requireShape(hasColumn, `${field}.column`);
  requireOptionalString(value.function, `${field}.function`);
}

/** Attribution crosses the wire as plain data, before listener registration. */
export function assertListenerOwners(value: unknown): void {
  const isAbsent = value === undefined;
  if (isAbsent) return;
  const isList = Array.isArray(value);
  requireShape(isList, 'owners');
  for (const owner of value) {
    requireRecord(owner, 'owner');
    switch (owner.kind) {
      case 'frame': {
        requireFramePosition(owner, 'owner');
        if (owner.stack === undefined) break;
        requireShape(Array.isArray(owner.stack), 'owner.stack');
        for (const frame of owner.stack) {
          requireRecord(frame, 'owner.stack');
          requireFramePosition(frame, 'owner.stack');
        }
        break;
      }
      case 'tag':
        requireString(owner.name, 'owner.name');
        requireOptionalString(owner.element, 'owner.element');
        break;
      case 'regions':
        requireStringList(owner.selectors, 'owner.selectors');
        break;
      case 'component': {
        requireString(owner.name, 'owner.name');
        const hasPath = owner.path !== undefined;
        if (hasPath) requireStringList(owner.path, 'owner.path');
        requireOptionalString(owner.element, 'owner.element');
        requireOptionalString(owner.tag, 'owner.tag');
        break;
      }
      default:
        requireShape(false, 'owner.kind');
    }
  }
}
