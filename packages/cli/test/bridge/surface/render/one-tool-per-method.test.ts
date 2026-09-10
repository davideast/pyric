/**
 * The shared rendering for the surfaces that expose one tool per method: one
 * rendered tool per mounted method record, named by the word order the
 * caller supplies, calling through `callMethod` and resolving back to the
 * canonical operation the arguments picked.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { renderOneToolPerMethod } from '../../../../src/bridge/surface/render/one-tool-per-method.js';
import type { MethodWords } from '../../../../src/bridge/surface/render/method-words.js';
import { METHODS } from '../../../../src/bridge/surface/methods/registry.js';

/** verb_service_object, the same order sdk-service and canonical ids use. */
function verbServiceObject(words: MethodWords): readonly string[] {
  return [words.verb, words.service, words.object];
}

describe('renderOneToolPerMethod', () => {
  it('renders one tool per mounted method, none dropped when production is not requested', () => {
    const surface = renderOneToolPerMethod(verbServiceObject);
    expect(surface.tools).toHaveLength(METHODS.length);
    const names = new Set(surface.tools.map((tool) => tool.name));
    expect(names.size).toBe(surface.tools.length);
  });

  it('names each tool with the word order the caller supplies', () => {
    const surface = renderOneToolPerMethod(verbServiceObject);
    expect(surface.tools.some((tool) => tool.name === 'get_firestore_document')).toBe(true);
  });

  it('throws when the name order claims the same name for two methods', () => {
    expect(() => renderOneToolPerMethod(() => ['same', 'name'])).toThrow(
      "rendered tool name 'same_name' is claimed by two methods",
    );
  });

  it('runs a call through callMethod, so an invalid call is refused before the handler runs', async () => {
    const surface = renderOneToolPerMethod(verbServiceObject);
    const ctx = createSurfaceContext(initializeSandbox());
    const tool = surface.tools.find((candidate) => candidate.name === 'get_firestore_document');
    if (!tool) throw new Error('expected a get_firestore_document tool');
    const rejected = await tool.execute({ path: 'users' }, ctx);
    expect(rejected.ok).toBe(false);
    const accepted = await tool.execute({ path: 'users/alice' }, ctx);
    expect(accepted.ok).toBe(true);
  });

  it('resolves a known tool name to the operation its arguments selected', () => {
    const surface = renderOneToolPerMethod(verbServiceObject);
    expect(surface.resolve('get_firestore_document', {})).toEqual({
      operation: 'get_firestore_document',
      action: null,
    });
  });

  it('resolves an unknown tool name to no operation and no action', () => {
    const surface = renderOneToolPerMethod(verbServiceObject);
    expect(surface.resolve('not_a_tool', {})).toEqual({ operation: null, action: null });
  });
});
