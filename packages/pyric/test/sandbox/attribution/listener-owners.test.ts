/** The owners a listener can be given at the moment it attaches. */
import { afterEach, describe, expect, it } from 'bun:test';
import { configureListenerAttribution } from '../../../src/sandbox/attribution/attribution-mode.js';
import { configureListenerOwnerFrames } from '../../../src/sandbox/attribution/owner-frames.js';
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
      stack: [
        { file: '/app/orders.ts', line: 42, column: 11, function: 'renderOrders' },
        { file: '/app/index.ts', line: 3, column: 1, function: 'main' },
      ],
    });
  });

  it('passes over runtime frames that belong to no application file', () => {
    const stack = [
      'Error',
      '    at watch (/app/src/db.js:5:10)',
      '    at map (native:1:11)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at main (/app/src/main.js:14:3)',
    ].join('\n');
    const frame = callerFrameFromStack(stack);
    expect(frame?.kind === 'frame' ? frame.stack?.map((entry) => entry.file) : []).toEqual(['/app/src/db.js', '/app/src/main.js']);
  });

  it('reports nothing when every frame belongs to a dependency', () => {
    const stack = 'Error\n    at attach (/repo/node_modules/pyric/dist/a.js:1:1)';
    expect(callerFrameFromStack(stack)).toBeUndefined();
  });
});

describe('callerFrameFromStack through a data-layer wrapper', () => {
  const throughWrapper = [
    'Error',
    '    at attach (/repo/node_modules/pyric/dist/sandbox/x.js:1:1)',
    '    at watch (/app/src/db.js:5:10)',
    '    at listRooms (/app/src/room-list.js:5:22)',
    '    at main (/app/src/main.js:14:3)',
    '    at boot (/app/src/boot.js:2:1)',
  ].join('\n');

  afterEach(() => {
    configureListenerOwnerFrames({});
  });

  it('keeps the first three application frames, innermost first', () => {
    expect(callerFrameFromStack(throughWrapper)).toEqual({
      kind: 'frame',
      file: '/app/src/db.js',
      line: 5,
      column: 10,
      function: 'watch',
      stack: [
        { file: '/app/src/db.js', line: 5, column: 10, function: 'watch' },
        { file: '/app/src/room-list.js', line: 5, column: 22, function: 'listRooms' },
        { file: '/app/src/main.js', line: 14, column: 3, function: 'main' },
      ],
    });
  });

  it('shows the first frame outside a skipped module and keeps the wrapper in the stack', () => {
    configureListenerOwnerFrames({ skip: ['src/db.js'] });
    expect(callerFrameFromStack(throughWrapper)).toEqual({
      kind: 'frame',
      file: '/app/src/room-list.js',
      line: 5,
      column: 22,
      function: 'listRooms',
      stack: [
        { file: '/app/src/db.js', line: 5, column: 10, function: 'watch' },
        { file: '/app/src/room-list.js', line: 5, column: 22, function: 'listRooms' },
        { file: '/app/src/main.js', line: 14, column: 3, function: 'main' },
        { file: '/app/src/boot.js', line: 2, column: 1, function: 'boot' },
      ],
    });
  });

  it('records one frame and no stack when one frame is asked for', () => {
    configureListenerOwnerFrames({ frames: 1 });
    expect(callerFrameFromStack(throughWrapper)).toEqual({
      kind: 'frame',
      file: '/app/src/db.js',
      line: 5,
      column: 10,
      function: 'watch',
    });
  });

  it('falls back to the first application frame when every frame is skipped', () => {
    configureListenerOwnerFrames({ skip: ['**'], frames: 1 });
    const frame = callerFrameFromStack(throughWrapper);
    expect(frame?.kind === 'frame' ? frame.file : undefined).toBe('/app/src/db.js');
  });

  it('matches skip globs against a served URL by its path, keeping the skipped frame', () => {
    configureListenerOwnerFrames({ skip: ['src/db/**'], frames: 1 });
    const served = [
      'Error',
      '    at watch (http://localhost:5173/src/db/index.js?t=1712:5:10)',
      '    at listRooms (http://localhost:5173/src/room-list.js:5:22)',
    ].join('\n');
    expect(callerFrameFromStack(served)).toEqual({
      kind: 'frame',
      file: 'http://localhost:5173/src/room-list.js',
      line: 5,
      column: 22,
      function: 'listRooms',
      stack: [
        { file: 'http://localhost:5173/src/db/index.js?t=1712', line: 5, column: 10, function: 'watch' },
        { file: 'http://localhost:5173/src/room-list.js', line: 5, column: 22, function: 'listRooms' },
      ],
    });
  });

  it('reads the frames of a runtime that writes function@file:line:column', () => {
    const firefox = [
      'attach@http://localhost:5173/node_modules/.vite/deps/pyric.js:1:1',
      'watch@http://localhost:5173/src/db.js:5:10',
      'listRooms@http://localhost:5173/src/room-list.js:5:22',
      '@http://localhost:5173/src/main.js:14:3',
    ].join('\n');
    configureListenerOwnerFrames({ skip: ['src/db.js'] });
    expect(callerFrameFromStack(firefox)).toEqual({
      kind: 'frame',
      file: 'http://localhost:5173/src/room-list.js',
      line: 5,
      column: 22,
      function: 'listRooms',
      stack: [
        { file: 'http://localhost:5173/src/db.js', line: 5, column: 10, function: 'watch' },
        { file: 'http://localhost:5173/src/room-list.js', line: 5, column: 22, function: 'listRooms' },
        { file: 'http://localhost:5173/src/main.js', line: 14, column: 3 },
      ],
    });
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

  it('keeps the calling chain from a real stack', () => {
    // Each call keeps its caller's frame: JavaScriptCore drops a tail caller.
    function watch(): ReturnType<typeof captureCreationFrame> {
      const frames = [captureCreationFrame()];
      return frames[0];
    }
    function listRooms(): ReturnType<typeof captureCreationFrame> {
      const frames = [watch()];
      return frames[0];
    }
    function main(): ReturnType<typeof captureCreationFrame> {
      const frames = [listRooms()];
      return frames[0];
    }
    configureListenerOwnerFrames({ frames: 3 });
    try {
      const frame = main();
      if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
      expect(frame.function).toBe('watch');
      expect(frame.stack?.map((entry) => entry.function)).toEqual(['watch', 'listRooms', 'main']);
    } finally {
      configureListenerOwnerFrames({});
    }
  });

  it('captures where the runtime has no stack trace limit to raise', () => {
    const errorConstructor = Error as { stackTraceLimit?: number };
    const limit = errorConstructor.stackTraceLimit;
    delete errorConstructor.stackTraceLimit;
    try {
      const frame = captureCreationFrame();
      expect('stackTraceLimit' in Error).toBe(false);
      if (frame !== undefined && frame.kind !== 'frame') throw new Error('expected a frame owner');
    } finally {
      errorConstructor.stackTraceLimit = limit;
    }
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

  it('records a component owner as it stands', () => {
    expect(tagOwnerFor({ kind: 'component', name: 'OrdersTable', path: ['App'] })).toEqual({
      kind: 'component',
      name: 'OrdersTable',
      path: ['App'],
    });
  });

  it('derives the selector for a component owner carrying an element', () => {
    const element = new FakeElement('section');
    element.id = 'orders';
    expect(tagOwnerFor({ kind: 'component', name: 'OrdersTable', element })).toEqual({
      kind: 'component',
      name: 'OrdersTable',
      element: '#orders',
      tag: 'section',
    });
  });

  it('keeps no element on the recorded component owner', () => {
    const element = new FakeElement('section');
    const owner = tagOwnerFor({ kind: 'component', name: 'OrdersTable', element });
    if (owner?.kind !== 'component') throw new Error('expected a component owner');
    expect(typeof owner.element).toBe('string');
    expect(JSON.parse(JSON.stringify(owner))).toEqual(owner);
  });

  it('drops an element that cannot be turned into a selector', () => {
    const owner = tagOwnerFor({
      kind: 'component',
      name: 'OrdersTable',
      element: {} as never,
    });
    expect(owner).toEqual({ kind: 'component', name: 'OrdersTable' });
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
