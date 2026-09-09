/**
 * The argument validator every service-tool call passes through: unknown
 * argument names (with a rename or a spelling suggestion), the Zod issue
 * translated into a signature-and-fix message, the method-name lookup a
 * `describe` call and a bad method name both go through, and `failFor`'s
 * rejection shape.
 *
 * Effect enforcement (destructive confirmation, production gating) is
 * `method-effects.test.ts`'s own subject; this file exercises the argument
 * checks that sit around it.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  argumentNames,
  DESCRIBE_METHOD,
  failFor,
  methodNames,
  validateArguments,
  validateDescribe,
  validateMethodName,
} from '../../../src/bridge/surface/method-validation.js';
import type { Method, Tool } from '../../../src/bridge/surface/method-types.js';

/** A method record built only for this test; never filed under `methods/`. */
function fakeMethod(overrides: Partial<Method> = {}): Method {
  return {
    tool: 'widgets',
    method: 'spin',
    sdkOrigin: 'pyric',
    effect: 'read',
    signature: 'spin(id, speed)',
    description: 'A method invented only to exercise the validator.',
    args: z.object({
      id: z.string().describe('The widget id.'),
      speed: z.enum(['slow', 'fast']),
    }),
    renames: { widgetId: 'id' },
    operation: 'spin_widget_for_test',
    example: { id: 'w1', speed: 'slow' },
    async handler() {
      return { ok: true, summary: 'spun' };
    },
    key: 'widgets.spin',
    ...overrides,
  };
}

function fakeTool(methods: Method[]): Tool {
  return { name: 'widgets', intro: 'test tool', order: 1, methods };
}

describe('failFor', () => {
  it('builds a rejection that names the tool, method, and field', () => {
    const fail = failFor('widgets', 'spin');
    const rejection = fail('id is bad.', 'Fix id.', 'id');
    expect(rejection.ok).toBe(false);
    expect(rejection.data).toEqual({
      code: 'invalid_arguments',
      tool: 'widgets',
      method: 'spin',
      field: 'id',
      fix: 'Fix id.',
    });
    expect(rejection.summary).toBe('widgets.spin: id is bad. Fix id.');
  });

  it('omits field when the caller does not supply one', () => {
    const rejection = failFor('widgets', 'spin')('bad.', 'Fix it.');
    expect(rejection.data.field).toBeUndefined();
  });
});

describe('argumentNames', () => {
  it('reads the names the schema declares', () => {
    expect(argumentNames(fakeMethod())).toEqual(['id', 'speed']);
  });
});

describe('validateArguments', () => {
  it('rejects an unknown argument with a known rename', () => {
    const rejection = validateArguments(fakeMethod(), { widgetId: 'w1', speed: 'slow' });
    expect(rejection?.data.field).toBe('widgetId');
    expect(rejection?.summary).toContain("names this argument 'id'");
  });

  it('rejects an unknown argument with no rename, naming the accepted set', () => {
    const rejection = validateArguments(fakeMethod(), { id: 'w1', speed: 'slow', extra: 1 });
    expect(rejection?.data.field).toBe('extra');
    expect(rejection?.summary).toContain('id, speed');
  });

  it('rejects a missing required argument', () => {
    const rejection = validateArguments(fakeMethod(), { speed: 'slow' });
    expect(rejection?.data.field).toBe('id');
    expect(rejection?.summary).toContain('is missing');
    expect(rejection?.summary).toContain('spin(id, speed)');
  });

  it('rejects a value of the wrong type', () => {
    const rejection = validateArguments(fakeMethod(), { id: 1, speed: 'slow' });
    expect(rejection?.summary).toContain('is number, not string');
  });

  it('rejects an enum value outside the closed set, suggesting the close one', () => {
    const rejection = validateArguments(fakeMethod(), { id: 'w1', speed: 'sloe' });
    expect(rejection?.data.fix).toContain("'slow'");
  });

  it('runs the record own validate after the schema passes', () => {
    const method = fakeMethod({
      validate(args, ctx) {
        if (args.id === 'forbidden') return ctx.fail('id is forbidden.', 'Use another id.', 'id');
        return null;
      },
    });
    const rejection = validateArguments(method, { id: 'forbidden', speed: 'slow' });
    expect(rejection?.summary).toContain('id is forbidden');
    expect(validateArguments(method, { id: 'ok', speed: 'slow' })).toBeNull();
  });

  it('passes well-formed arguments through to null', () => {
    expect(validateArguments(fakeMethod(), { id: 'w1', speed: 'slow' })).toBeNull();
  });
});

describe('methodNames and validateMethodName', () => {
  const tool = fakeTool([fakeMethod(), fakeMethod({ method: 'stop', key: 'widgets.stop' })]);

  it('lists every method plus describe, describe last', () => {
    expect(methodNames(tool)).toEqual(['spin', 'stop', DESCRIBE_METHOD]);
  });

  it('rejects a missing or non-string method name', () => {
    expect(validateMethodName(tool, undefined)?.data.field).toBe('method');
    expect(validateMethodName(tool, 42)?.data.field).toBe('method');
  });

  it('rejects an unknown method name, suggesting the close one', () => {
    const rejection = validateMethodName(tool, 'spinn');
    expect(rejection?.summary).toContain("Did you mean 'spin'?");
  });

  it('rejects an unknown method with no close match, with no suggestion in the fix', () => {
    const rejection = validateMethodName(tool, 'zzzzzzzzzzzzzzzz');
    expect(rejection?.data.fix).not.toContain('Did you mean');
  });

  it('passes a method the tool carries', () => {
    expect(validateMethodName(tool, 'spin')).toBeNull();
    expect(validateMethodName(tool, DESCRIBE_METHOD)).toBeNull();
  });
});

describe('validateDescribe', () => {
  const tool = fakeTool([fakeMethod()]);

  it('rejects a non-string args.method', () => {
    const rejection = validateDescribe(tool, {});
    expect(rejection?.data.field).toBe('method');
    expect(rejection?.data.fix).toContain("args: { method:");
  });

  it('rejects a method name the tool does not carry', () => {
    const rejection = validateDescribe(tool, { method: 'stop' });
    expect(rejection?.summary).toContain('does not carry');
  });

  it('passes a method name the tool does carry', () => {
    expect(validateDescribe(tool, { method: 'spin' })).toBeNull();
  });
});
