import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { sandboxEventSource } from '../../../src/serve/runtime/listener-event-source.js';

function event(id: string): SandboxEvent {
  return { kind: 'listener_attach', id, at: 1, listenerId: id, target: { kind: 'doc', path: 'a/b' }, auth: {} } as unknown as SandboxEvent;
}

describe('sandboxEventSource', () => {
  it('has no source when the page runs neither sandbox', () => {
    expect(sandboxEventSource({})).toBeNull();
  });

  it('delivers the in-page sandbox history first, then each live event', () => {
    let live: ((event: SandboxEvent) => void) | null = null;
    const source = sandboxEventSource({
      sandbox: {
        history: () => [event('e1')],
        onEvent: (listener) => {
          live = listener;
          return () => {
            live = null;
          };
        },
      },
    })!;

    const batches: string[][] = [];
    const unsubscribe = source((events) => batches.push(events.map((item) => item.id)));
    live?.(event('e2'));
    expect(batches).toEqual([['e1'], ['e2']]);

    unsubscribe();
    expect(live).toBeNull();
  });
});
