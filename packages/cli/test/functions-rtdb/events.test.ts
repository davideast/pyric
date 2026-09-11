/**
 * The Functions trigger runtime's emit sites: what each one lands on the
 * sandbox event stream, and that a failure to emit never reaches the caller.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox, type LocalSandbox, type SandboxEvent } from 'pyric/sandbox';
import {
  emitExecutionFinished,
  emitHandlerFired,
  emitTriggerDiscovered,
} from '../../src/functions-rtdb/events.js';

function functionsEvents(sandbox: LocalSandbox): Array<SandboxEvent & { op: string }> {
  return sandbox
    .history()
    .filter(
      (event) => event.kind === 'service_mutation' && event.service === 'functions',
    ) as Array<SandboxEvent & { op: string }>;
}

describe('functions event emission', () => {
  test('reports a discovered trigger against its reference pattern', () => {
    const sandbox = initializeSandbox();
    emitTriggerDiscovered(sandbox, {
      exportName: 'makeUppercase',
      reference: '/messages/{pushId}/original',
      instance: 'demo-default-rtdb',
    });
    const [event] = functionsEvents(sandbox) as Array<{
      op: string;
      path?: string;
      detail?: Record<string, unknown>;
    }>;
    expect(event!.op).toBe('trigger_discovered');
    expect(event!.path).toBe('/messages/{pushId}/original');
    expect(event!.detail?.trigger).toBe('makeUppercase');
  });

  test("reports a fired handler against the synthetic event's own path", () => {
    const sandbox = initializeSandbox();
    emitHandlerFired(sandbox, {
      trigger: 'makeUppercase',
      ref: 'messages/abc/original',
      params: { pushId: 'abc' },
    });
    const [event] = functionsEvents(sandbox) as Array<{ op: string; path?: string }>;
    expect(event!.op).toBe('handler_fired');
    expect(event!.path).toBe('messages/abc/original');
  });

  test('reports a finished run with its duration and its result', () => {
    const sandbox = initializeSandbox();
    emitExecutionFinished(sandbox, {
      trigger: 'makeUppercase',
      ref: 'messages/abc/original',
      params: {},
      startedAt: 5,
      durationMs: 2,
      status: 'fulfilled',
      result: 'HELLO',
    });
    const [event] = functionsEvents(sandbox) as Array<{
      op: string;
      detail?: Record<string, unknown>;
    }>;
    expect(event!.op).toBe('execution_finished');
    expect(event!.detail?.durationMs).toBe(2);
    expect(event!.detail?.result).toBe('HELLO');
    expect(event!.detail?.error).toBeUndefined();
  });

  test('never lets a refused sandbox handle reach the caller', () => {
    const notASandbox = { history: () => [] } as unknown as LocalSandbox;
    expect(() =>
      emitTriggerDiscovered(notASandbox, {
        exportName: 'a',
        reference: '/x/{id}',
        instance: 'demo',
      }),
    ).not.toThrow();
  });
});
