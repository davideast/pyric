/**
 * The `verb-suffixed` surface: the verb leads, the object follows, and the
 * service trails, so the name reads as the action on the thing.
 */
import { renderOneToolPerMethod } from './one-tool-per-method.js';
import type { RenderedSurface } from '../types.js';

export function render(): RenderedSurface {
  return renderOneToolPerMethod((words) => [words.verb, words.object, words.service]);
}
