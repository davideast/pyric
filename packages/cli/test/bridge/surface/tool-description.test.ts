/**
 * How one service tool's description is written from its method records:
 * grouped by effect in a fixed order, one line per method, closed with the
 * sentence pointing at `describe`, and refused when the rendered text goes
 * over the length limit.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  DESCRIPTION_LIMIT,
  renderToolDescription,
  renderToolDescriptions,
} from '../../../src/bridge/surface/tool-description.js';
import type { Method, Tool } from '../../../src/bridge/surface/method-types.js';

/** A method record built only for this test; never filed under `methods/`. */
function fakeMethod(overrides: Partial<Method>): Method {
  return {
    tool: 'widgets',
    method: 'spin',
    sdkOrigin: 'pyric',
    effect: 'read',
    signature: 'spin(id)',
    description: 'Spin one widget.',
    args: z.object({ id: z.string() }),
    operation: 'spin_widget_for_test',
    example: { id: 'w1' },
    async handler() {
      return { ok: true, summary: 'spun' };
    },
    key: 'widgets.spin',
    ...overrides,
  };
}

function fakeTool(methods: Method[]): Tool {
  return { name: 'widgets', intro: 'A tool invented only to exercise rendering.', order: 1, methods };
}

describe('renderToolDescription', () => {
  it('opens with the intro and closes with the describe sentence', () => {
    const description = renderToolDescription(fakeTool([fakeMethod({})]));
    expect(description.startsWith('A tool invented only to exercise rendering.')).toBe(true);
    expect(description).toContain(
      "Call method 'describe' with args { method } to read the full schema",
    );
  });

  it('groups methods by effect, in read, write, destructive, production order', () => {
    const description = renderToolDescription(
      fakeTool([
        fakeMethod({ effect: 'production', method: 'wipe', key: 'widgets.wipe' }),
        fakeMethod({ effect: 'destructive', method: 'discard', key: 'widgets.discard' }),
        fakeMethod({ effect: 'write', method: 'set', key: 'widgets.set' }),
        fakeMethod({ effect: 'read', method: 'get', key: 'widgets.get' }),
      ]),
    );
    const readAt = description.indexOf('Read methods');
    const writeAt = description.indexOf('Write methods');
    const destructiveAt = description.indexOf('Destructive methods');
    const productionAt = description.indexOf('Production methods');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(writeAt);
    expect(writeAt).toBeLessThan(destructiveAt);
    expect(destructiveAt).toBeLessThan(productionAt);
  });

  it('omits a group with no methods rather than an empty heading', () => {
    const description = renderToolDescription(fakeTool([fakeMethod({ effect: 'read' })]));
    expect(description).not.toContain('Write methods');
    expect(description).not.toContain('Destructive methods');
    expect(description).not.toContain('Production methods');
  });

  it('renders each method as its signature and description', () => {
    const description = renderToolDescription(fakeTool([fakeMethod({})]));
    expect(description).toContain('spin(id): Spin one widget.');
  });

  it('throws when the rendered description exceeds the length limit', () => {
    const method = fakeMethod({ description: 'x'.repeat(DESCRIPTION_LIMIT + 100) });
    expect(() => renderToolDescription(fakeTool([method]))).toThrow(
      new RegExp(`widgets description is \\d+ characters, over the ${DESCRIPTION_LIMIT} limit`),
    );
  });
});

describe('renderToolDescriptions', () => {
  it('renders every tool, keyed by name', () => {
    const rendered = renderToolDescriptions([
      fakeTool([fakeMethod({})]),
      { ...fakeTool([fakeMethod({ tool: 'gadgets', key: 'gadgets.spin' })]), name: 'gadgets' },
    ]);
    expect(Object.keys(rendered)).toEqual(['widgets', 'gadgets']);
    expect(rendered.widgets).toContain('spin(id)');
  });
});
