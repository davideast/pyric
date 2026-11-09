/**
 * A live Node process sends its unobserved lists to the live host when a
 * list first gains an entry and on each change, bounded, names only.
 */
import { describe, expect, it } from 'bun:test';
import type { NodeUnobservedLists } from 'pyric/sandbox/internal';
import { createUnobservedForwarder, onReattach } from '../../src/register/unobserved-forward.js';

/** A forwarder whose turns run when the test says, over lists the test sets. */
function forwarder(options: { fail?: () => boolean } = {}) {
  const lists: { unobservedAdmin: string[]; gatedAdmin: string[] } = { unobservedAdmin: [], gatedAdmin: [] };
  const sent: NodeUnobservedLists[] = [];
  const queued: Array<() => void> = [];
  let release: (() => void) | undefined;
  let holds = false;
  const forward = createUnobservedForwarder({
    read: () => lists,
    send: (frame) => {
      sent.push(frame);
      if (options.fail?.() === true) return Promise.reject(new Error('the live host is not reachable'));
      if (!holds) return Promise.resolve();
      return new Promise<void>((resolve) => (release = resolve));
    },
    schedule: (flush) => void queued.push(flush),
  });
  const turn = async (): Promise<void> => {
    for (const flush of queued.splice(0)) flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { lists, sent, forward, turn, hold: () => (holds = true), release: () => release?.() };
}

describe('the unobserved lists forwarder', () => {
  it('sends the lists once per burst of changes, and again only when they change', async () => {
    const { lists, sent, forward, turn } = forwarder();
    lists.unobservedAdmin.push('firebase-admin/remote-config');
    forward.changed();
    lists.unobservedAdmin.push('firebase-admin/security-rules');
    forward.changed();
    await turn();
    expect(sent).toEqual([{ unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/security-rules'] }]);
    forward.changed();
    await turn();
    expect(sent).toHaveLength(1);
    lists.gatedAdmin.push('firebase-admin/app-check');
    forward.changed();
    await turn();
    expect(sent[1]).toEqual({
      unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/security-rules'],
      gatedAdmin: ['firebase-admin/app-check'],
    });
  });

  it('sends names only, each once, at most 64 to a list', async () => {
    const { lists, sent, forward, turn } = forwarder();
    lists.unobservedAdmin.push(
      'firebase-admin/remote-config',
      'firebase-admin/remote-config',
      'https://user:secret@cloudtrace.googleapis.com/v2?key=k',
      'firebase-admin/remote-config?x=1',
      ...Array.from({ length: 80 }, (_, index) => `firebase-admin/service-${index}`),
    );
    lists.gatedAdmin.push('firebase-admin/app-check?x=1');
    forward.changed();
    await turn();
    const [frame] = sent;
    expect(frame?.unobservedAdmin).toHaveLength(64);
    expect(frame?.unobservedAdmin?.[0]).toBe('firebase-admin/remote-config');
    expect(frame?.unobservedAdmin?.[1]).toBe('firebase-admin/service-0');
    expect(frame).not.toHaveProperty('gatedAdmin');
  });

  it('sends nothing while every list is empty', async () => {
    const { sent, forward, turn } = forwarder();
    forward.changed();
    await turn();
    expect(sent).toEqual([]);
  });

  it('sends a frame that failed again at the next change', async () => {
    let fails = true;
    const { lists, sent, forward, turn } = forwarder({ fail: () => fails });
    lists.unobservedAdmin.push('firebase-admin/remote-config');
    forward.changed();
    await turn();
    fails = false;
    forward.changed();
    await turn();
    expect(sent).toEqual([
      { unobservedAdmin: ['firebase-admin/remote-config'] },
      { unobservedAdmin: ['firebase-admin/remote-config'] },
    ]);
  });

  it('sends a change made while a send is in flight once that send ends', async () => {
    const { lists, sent, forward, turn, hold, release } = forwarder();
    hold();
    lists.unobservedAdmin.push('firebase-admin/remote-config');
    forward.changed();
    await turn();
    lists.unobservedAdmin.push('firebase-admin/security-rules');
    forward.changed();
    await turn();
    expect(sent).toHaveLength(1);
    release();
    await turn();
    await turn();
    expect(sent[1]).toEqual({ unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/security-rules'] });
  });

  it('sends the lists again when the connection re-attaches, as after a live host restart', async () => {
    const { lists, sent, forward, turn } = forwarder();
    let report: (connected: boolean) => void = () => undefined;
    onReattach((listener) => {
      report = listener;
      return () => undefined;
    }, () => forward.reconnected());
    report(false);
    report(true);
    lists.unobservedAdmin.push('firebase-admin/remote-config');
    forward.changed();
    await turn();
    expect(sent).toHaveLength(1);
    // The host restarts: the socket drops, then attaches to the new host, which has no lists.
    report(false);
    report(true);
    await turn();
    expect(sent).toEqual([
      { unobservedAdmin: ['firebase-admin/remote-config'] },
      { unobservedAdmin: ['firebase-admin/remote-config'] },
    ]);
  });

  it('counts only an attach that follows a drop as a re-attach', () => {
    let report: (connected: boolean) => void = () => undefined;
    let reattached = 0;
    onReattach((listener) => {
      report = listener;
      return () => undefined;
    }, () => void reattached++);
    report(false);
    report(true);
    report(true);
    expect(reattached).toBe(0);
    report(false);
    report(false);
    report(true);
    expect(reattached).toBe(1);
  });
});
