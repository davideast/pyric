/**
 * The `noun-prefixed` surface: the subject leads and the verb trails, so a
 * client that sorts tool names groups every method on one object together.
 */
import { renderOneToolPerMethod } from './one-tool-per-method.js';
import type { RenderedSurface, RenderOptions } from '../types.js';

export function render(options?: RenderOptions): RenderedSurface {
  return renderOneToolPerMethod((words) => [words.service, words.object, words.verb], options);
}
