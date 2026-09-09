/**
 * The `verb-prefixed` variant: the canonical id is the tool name, so the name
 * an agent picks and the id the audit log records are the same string.
 */
import { renderOneToolPerOperation } from './one-tool-per-operation.js';
import type { Operation, RenderedSurface } from '../types.js';

export function render(operations: readonly Operation[]): RenderedSurface {
  return renderOneToolPerOperation(operations, (operation) => operation.id);
}
