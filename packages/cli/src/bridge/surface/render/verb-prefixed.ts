/**
 * The `verb-prefixed` surface: the verb leads, the service follows, and the
 * object trails, which is the canonical operation vocabulary's own word order.
 */
import { renderOneToolPerMethod } from './one-tool-per-method.js';
import type { RenderedSurface } from '../types.js';

export function render(): RenderedSurface {
  return renderOneToolPerMethod((words) => [words.verb, words.service, words.object]);
}
