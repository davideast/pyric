/**
 * The `verb-suffixed` variant: the verb leads, the object follows, and the
 * service trails, so the name reads as the action on the thing.
 */
import { renderOneToolPerOperation } from './one-tool-per-operation.js';
import type { Operation, RenderedSurface } from '../types.js';

export function render(operations: readonly Operation[]): RenderedSurface {
  return renderOneToolPerOperation(
    operations,
    (operation) => `${operation.verb}_${operation.object}_${operation.service}`,
  );
}
