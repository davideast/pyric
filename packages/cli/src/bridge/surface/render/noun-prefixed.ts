/**
 * The `noun-prefixed` surface: the subject leads and the verb trails, so a
 * client that sorts tool names groups every method on one object together.
 */
import { renderOneToolPerMethod } from './one-tool-per-method.js';
import type { RenderedSurface } from '../types.js';

export function render(): RenderedSurface {
  return renderOneToolPerMethod((words) => `${words.service}_${words.object}_${words.verb}`);
}
