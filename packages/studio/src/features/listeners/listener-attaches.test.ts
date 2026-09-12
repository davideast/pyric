/** The attach sites the incident block lists. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { attachSites } from './listener-attaches.js';

const CONTEXT = { source: { kind: 'app' as const }, authLens: { mode: 'app-session' as const } };

function attach(
  id: string,
  at: number,
  owners?: unknown[],
  target: unknown = { kind: 'doc', path: 'notes/one' },
): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId: id,
    target,
    auth: null,
    operationContext: CONTEXT,
    ...(owners ? { owners } : {}),
  } as unknown as SandboxEvent;
}

const CHAT = [
  { kind: 'component', name: 'ChatPage', element: '#conversations' },
  { kind: 'tag', name: 'nav' },
  { kind: 'frame', file: 'src/ui/chat/chat-page.tsx', line: 318 },
];

describe('attachSites', () => {
  it('lists every attach sharing the target and the owner, in attach order', () => {
    const events = [
      attach('a', 1000, CHAT),
      attach('b', 2000, CHAT),
      attach('c', 3000, CHAT, { kind: 'doc', path: 'notes/other' }),
      attach('d', 4000, [{ kind: 'component', name: 'Sidebar' }]),
    ];
    expect(attachSites(events, 'notes/one', 'ChatPage')).toEqual([
      { at: 1000, frame: 'src/ui/chat/chat-page.tsx:318', element: 'nav#conversations' },
      { at: 2000, frame: 'src/ui/chat/chat-page.tsx:318', element: 'nav#conversations' },
    ]);
  });

  it('matches a query target by its collection and query mark', () => {
    const events = [attach('a', 1000, CHAT, { kind: 'query', collection: 'conversations', query: {} })];
    const sites = attachSites(events, { collection: 'conversations', query: {} }, 'ChatPage');
    expect(sites).toHaveLength(1);
  });

  it('files an unowned attach under its target', () => {
    const events = [attach('a', 1000)];
    expect(attachSites(events, 'notes/one', 'notes/one')).toEqual([{ at: 1000 }]);
  });

  it('reads a database attach off the canonical listener event', () => {
    const event = {
      kind: 'listener',
      id: 'r1',
      at: 500,
      listenerId: 'r1',
      phase: 'attach',
      service: 'rtdb',
      target: { kind: 'path', path: '/presence' },
      operationContext: CONTEXT,
      owners: [{ kind: 'tag', name: 'presence' }],
    } as unknown as SandboxEvent;
    expect(attachSites([event], '/presence', 'presence')).toEqual([{ at: 500 }]);
  });
});
