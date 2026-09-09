/**
 * The `noun-prefixed` variant: the subject leads and the verb trails, so a
 * client that sorts tool names groups every operation on one object together.
 */
import { renderOneToolPerOperation } from './one-tool-per-operation.js';
import type { Operation, RenderedSurface } from '../types.js';

export function render(operations: readonly Operation[]): RenderedSurface {
  return renderOneToolPerOperation(
    operations,
    (operation) => `${operation.service}_${operation.object}_${operation.verb}`,
  );
}
