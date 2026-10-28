/**
 * The host keeps sign-in results a served test staged (`auth.mockSignInResult`)
 * per port, one slot per provider id (#1466 part 2).
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../host.js';
import { stagedSignInResultsFor } from '../host-auth.js';
import { createStagedSignInResults } from '../host/staged-sign-in-results.js';
import type { InboundMessage, OutboundMessage, ResMessage, ResolvedIdentity } from '../protocol.js';

function identity(uid: string, providerId = 'google.com'): ResolvedIdentity {
  return { uid, providerId, email: `${uid}@example.com`, displayName: null, photoURL: null, customClaims: {} };
}

function recordingPort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (message) => messages.push(message) };
}

function hostCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { sandbox, db: getFirestore(sandbox), subs: new Map(), sessionMode: 'LOCAL' };
}

async function stageOverPort(
  ctx: HostCtx,
  port: PortLike & { messages: OutboundMessage[] },
  staged: unknown,
): Promise<ResMessage> {
  const id = crypto.randomUUID();
  await handleMessage(ctx, port, { t: 'op', id, method: 'auth.mockSignInResult', identity: staged } as InboundMessage);
  const reply = port.messages.find((message): message is ResMessage => message.t === 'res' && message.id === id);
  if (reply === undefined) throw new Error('No response from host');
  return reply;
}

describe('createStagedSignInResults', () => {
  it('hands a staged result to one take, then has none', () => {
    const staged = createStagedSignInResults();
    const port = recordingPort();
    staged.stage(port, identity('alice'));

    expect(staged.take(port, 'google.com')?.uid).toBe('alice');
    expect(staged.take(port, 'google.com')).toBeNull();
  });

  it('keeps the last result staged for a provider', () => {
    const staged = createStagedSignInResults();
    const port = recordingPort();
    staged.stage(port, identity('first'));
    staged.stage(port, identity('second'));

    expect(staged.take(port, 'google.com')?.uid).toBe('second');
    expect(staged.take(port, 'google.com')).toBeNull();
  });

  it('matches by provider id', () => {
    const staged = createStagedSignInResults();
    const port = recordingPort();
    staged.stage(port, identity('gh', 'github.com'));

    expect(staged.take(port, 'google.com')).toBeNull();
    expect(staged.take(port, 'github.com')?.uid).toBe('gh');
  });

  it('keeps a result staged on one port from being taken on another', () => {
    const staged = createStagedSignInResults();
    const stagingPort = recordingPort();
    const otherPort = recordingPort();
    staged.stage(stagingPort, identity('alice'));

    expect(staged.take(otherPort, 'google.com')).toBeNull();
    expect(staged.take(stagingPort, 'google.com')?.uid).toBe('alice');
  });
});

describe('auth.mockSignInResult on the host', () => {
  it('stages the identity for the calling port and replies null', async () => {
    const ctx = hostCtx();
    const port = recordingPort();
    const otherPort = recordingPort();

    const reply = await stageOverPort(ctx, port, identity('alice'));

    expect(reply).toMatchObject({ ok: true, value: null });
    expect(stagedSignInResultsFor(ctx).take(otherPort, 'google.com')).toBeNull();
    expect(stagedSignInResultsFor(ctx).take(port, 'google.com')).toEqual(identity('alice'));
  });

  it('refuses a result without a uid and stages nothing', async () => {
    const ctx = hostCtx();
    const port = recordingPort();
    const { uid: _uid, ...withoutUid } = identity('alice');

    const reply = await stageOverPort(ctx, port, withoutUid);

    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    expect(stagedSignInResultsFor(ctx).take(port, 'google.com')).toBeNull();
  });

  it('refuses a result whose providerId is not a string', async () => {
    const ctx = hostCtx();
    const port = recordingPort();

    const reply = await stageOverPort(ctx, port, { ...identity('alice'), providerId: 7 });

    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
  });
});
