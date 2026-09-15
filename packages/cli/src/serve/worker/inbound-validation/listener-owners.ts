import { requireRecord, requireShape, requireString, requireOptionalString } from './fields.js';

function requireStringList(value: unknown, field: string): void {
  const isList = Array.isArray(value) && value.every(item => typeof item === 'string');
  requireShape(isList, field);
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
        requireString(owner.file, 'owner.file');
        const hasLine = typeof owner.line === 'number' && Number.isFinite(owner.line);
        requireShape(hasLine, 'owner.line');
        const hasColumn = owner.column === undefined || typeof owner.column === 'number' && Number.isFinite(owner.column);
        requireShape(hasColumn, 'owner.column');
        requireOptionalString(owner.function, 'owner.function');
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
