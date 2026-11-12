/**
 * A live page sends its signed-in user's email with its presence: once when
 * it registers, and again when the user changes.
 */
import { describe, expect, it } from 'bun:test';
import { startPresence } from '../../../src/serve/worker/client/presence.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

function fakeDb(): { db: ClientDb; sent: InboundMessage[] } {
  const sent: InboundMessage[] = [];
  const port: ClientPort = {
    onmessage: null,
    postMessage: (message) => sent.push(message),
    start: () => {},
    close: () => {},
  };
  return { db: { __kind: 'client-db', port }, sent };
}

function fakeIdentity(email: string | null) {
  let current = email === null ? null : { email };
  const listeners = new Set<(user: { email: string | null } | null) => void>();
  return {
    current: () => current,
    subscribe(listener: (user: { email: string | null } | null) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change(next: string | null) {
      current = next === null ? null : { email: next };
      for (const listener of listeners) listener(current);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function presenceFrames(sent: InboundMessage[]): Record<string, unknown>[] {
  return sent
    .map((message) => message as unknown as Record<string, unknown>)
    .filter((message) => typeof message.method === 'string' && message.method.startsWith('presence.'));
}

describe('page presence email', () => {
  it('registers with the current email, and updates when the user changes', async () => {
    const { db, sent } = fakeDb();
    const identity = fakeIdentity('ada@example.com');
    const session = startPresence({ db, kind: 'app', identity });
    await settle();
    identity.change('grace@example.com');
    identity.change(null);
    await settle();
    const frames = presenceFrames(sent);
    expect(frames.map((frame) => [frame.method, frame.email])).toEqual([
      ['presence.register', 'ada@example.com'],
      ['presence.update', 'grace@example.com'],
      ['presence.update', null],
    ]);
    session.stop();
    await settle();
    identity.change('ada@example.com');
    await settle();
    expect(presenceFrames(sent).map((frame) => frame.method).slice(3)).toEqual(['presence.disconnect']);
  });

  it('sends no email field when the page has no identity source', async () => {
    const { db, sent } = fakeDb();
    startPresence({ db, kind: 'app' }).stop();
    await settle();
    expect(presenceFrames(sent).every((frame) => !('email' in frame))).toBe(true);
  });

  it('emits presence.update when non-email users (anonymous/phone/custom) sign in, switch uids, or sign out', async () => {
    const { db, sent } = fakeDb();
    let current: { uid: string; email: string | null } | null = null;
    const listeners = new Set<(user: { uid: string; email: string | null } | null) => void>();
    const identity = {
      current: () => current,
      subscribe(listener: (user: { uid: string; email: string | null } | null) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next: { uid: string; email: string | null } | null) {
        current = next;
        for (const listener of listeners) listener(current);
      },
    };
    const session = startPresence({ db, kind: 'app', identity });
    await settle();
    identity.set({ uid: 'u-anon-1', email: null });
    identity.set({ uid: 'u-anon-2', email: null });
    identity.set(null);
    await settle();
    expect(presenceFrames(sent).map((f) => [f.method, f.uid, f.email])).toEqual([
      ['presence.register', null, null],
      ['presence.update', 'u-anon-1', null],
      ['presence.update', 'u-anon-2', null],
      ['presence.update', null, null],
    ]);
    session.stop();
  });
});
