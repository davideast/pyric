/** The owners a listener can be given at the moment it attaches. */
import { afterEach, describe, expect, it } from 'bun:test';
import { configureListenerAttribution } from '../../../src/sandbox/attribution/attribution-mode.js';
import {
  callerFrameFromStack,
  captureCreationFrame,
  listenerAttachOwners,
  parseStackFrame,
  tagOwnerFor,
} from '../../../src/sandbox/attribution/listener-owners.js';
import { OWNER_ATTRIBUTE } from '../../../src/sandbox/attribution/element-selector.js';
import { FakeElement } from '../../fixtures/fake-dom.js';

afterEach(() => {
  configureListenerAttribution('auto');
});

describe('parseStackFrame', () => {
  it('reads the named-function form', () => {
    expect(parseStackFrame('    at renderOrders (/app/orders.ts:42:11)')).toEqual({
      kind: 'frame',
      file: '/app/orders.ts',
      line: 42,
      column: 11,
      function: 'renderOrders',
    });
  });

  it('reads the bare form and strips a file URL scheme', () => {
    expect(parseStackFrame('    at file:///app/orders.ts:7:3')).toEqual({
      kind: 'frame',
      file: '/app/orders.ts',
      line: 7,
      column: 3,
    });
  });

  it('ignores a line that is not a frame', () => {
    expect(parseStackFrame('Error')).toBeUndefined();
  });
});

describe('callerFrameFromStack', () => {
  it('skips installed dependencies and takes the first application frame', () => {
    const stack = [
      'Error',
      '    at attach (/repo/node_modules/pyric/dist/sandbox/x.js:1:1)',
      '    at renderOrders (/app/orders.ts:42:11)',
      '    at main (/app/index.ts:3:1)',
    ].join('\n');
    expect(callerFrameFromStack(stack)).toEqual({
      kind: 'frame',
      file: '/app/orders.ts',
      line: 42,
      column: 11,
      function: 'renderOrders',
    });
  });

  it('reports nothing when every frame belongs to a dependency', () => {
    const stack = 'Error\n    at attach (/repo/node_modules/pyric/dist/a.js:1:1)';
    expect(callerFrameFromStack(stack)).toBeUndefined();
  });
});

describe('captureCreationFrame', () => {
  it('names the calling file, not a pyric file', () => {
    const frame = captureCreationFrame();
    expect(frame?.kind).toBe('frame');
    if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
    expect(frame.file).toContain('listener-owners.test.ts');
    expect(frame.file).not.toContain('/src/sandbox/attribution/');
    expect(frame.line).toBeGreaterThan(0);
  });

  it('captures nothing when attribution is off', () => {
    configureListenerAttribution('off');
    expect(captureCreationFrame()).toBeUndefined();
  });
});

describe('tagOwnerFor', () => {
  it('takes a caller-supplied name verbatim', () => {
    expect(tagOwnerFor('orders-table')).toEqual({ kind: 'tag', name: 'orders-table' });
  });

  it('reads an element as its tag name plus a selector', () => {
    const element = new FakeElement('table');
    element.id = 'orders';
    expect(tagOwnerFor(element)).toEqual({
      kind: 'tag',
      name: 'table',
      element: '#orders',
    });
  });

  it('mints a selector for an element with no identity', () => {
    const element = new FakeElement('section');
    const owner = tagOwnerFor(element);
    if (owner?.kind !== 'tag') throw new Error('expected a tag owner');
    expect(owner.element).toBe(`[${OWNER_ATTRIBUTE}="${element.getAttribute(OWNER_ATTRIBUTE)}"]`);
  });

  it('reports nothing for an absent or empty hint', () => {
    expect(tagOwnerFor(undefined)).toBeUndefined();
    expect(tagOwnerFor('')).toBeUndefined();
  });
});

describe('listenerAttachOwners', () => {
  it('puts the frame first and the tag second', () => {
    const owners = listenerAttachOwners('orders-table');
    expect(owners?.map((owner) => owner.kind)).toEqual(['frame', 'tag']);
  });

  it('carries only the tag when attribution is off', () => {
    configureListenerAttribution('off');
    expect(listenerAttachOwners('orders-table')).toEqual([
      { kind: 'tag', name: 'orders-table' },
    ]);
  });

  it('reports nothing when there is neither a frame nor a tag', () => {
    configureListenerAttribution('off');
    expect(listenerAttachOwners()).toBeUndefined();
  });
});
