/**
 * Tests for confirm.ts — handler factory behavior.
 *
 * Uses a programmable fake PromptIO so we can simulate user
 * keystrokes without a real TTY.
 */

import { describe, expect, test } from 'bun:test';
import {
  createInteractiveConfirmHandler,
  createAutoApproveHandler,
  createDenyAllHandler,
  createPolicyHandler,
  type ConfirmHandler,
} from '../../src/bridge/server/confirm.js';
import {
  buildPolicyMap,
  DEFAULT_PROD_POLICIES,
  type ConfirmPolicy,
} from '../../src/bridge/server/confirm-policy.js';
import type { PromptIO, PromptKey } from '../../src/bridge/server/confirm-prompt.js';

// ── Fake PromptIO ────────────────────────────────────────────────────

interface FakeIO extends PromptIO {
  writes: string[];
  /** Queue keys to return for sequential readKey() calls. */
  enqueueKeys(...keys: PromptKey[]): void;
  /** Resolve any pending readKey with the given key. */
  pressKey(key: PromptKey): void;
  /** Count of times readKey was awaited (== prompts shown). */
  promptCount: number;
}

function createFakeIO(): FakeIO {
  const writes: string[] = [];
  const queued: PromptKey[] = [];
  const pendingResolvers: Array<(k: PromptKey) => void> = [];
  let promptCount = 0;

  return {
    writes,
    enqueueKeys(...keys: PromptKey[]) {
      queued.push(...keys);
      // Drain pending readers with queued keys.
      while (pendingResolvers.length > 0 && queued.length > 0) {
        const resolve = pendingResolvers.shift()!;
        const key = queued.shift()!;
        resolve(key);
      }
    },
    pressKey(key: PromptKey) {
      this.enqueueKeys(key);
    },
    get promptCount() {
      return promptCount;
    },
    set promptCount(_v: number) {
      /* readonly via getter */
    },
    isInteractive: () => true,
    write(text: string) {
      writes.push(text);
    },
    readKey(timeoutMs: number): Promise<PromptKey> {
      promptCount += 1;
      return new Promise((resolve) => {
        if (queued.length > 0) {
          resolve(queued.shift()!);
          return;
        }
        pendingResolvers.push(resolve);
        // Honor the timeout so tests can also exercise the timeout path.
        setTimeout(() => {
          const idx = pendingResolvers.indexOf(resolve);
          if (idx >= 0) {
            pendingResolvers.splice(idx, 1);
            resolve('timeout');
          }
        }, timeoutMs);
      });
    },
    close() {},
  };
}

function makeInteractive(opts?: {
  policies?: ReadonlyMap<string, ConfirmPolicy>;
  io?: FakeIO;
  timeoutMs?: number;
}): { handler: ConfirmHandler; io: FakeIO } {
  const io = opts?.io ?? createFakeIO();
  const policies = opts?.policies ?? DEFAULT_PROD_POLICIES;
  const handler = createInteractiveConfirmHandler({
    policies,
    timeoutMs: opts?.timeoutMs ?? 250,
    io,
    useColor: false,
  });
  return { handler, io };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('createInteractiveConfirmHandler — fast paths', () => {
  test("policy 'never' returns approved without prompting", async () => {
    const { handler, io } = makeInteractive();
    const decision = await handler.ask({
      tool: 'firestore_get_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('policy-never');
    expect(io.promptCount).toBe(0);
  });

  test("policy 'deny' returns denied without prompting", async () => {
    const policies = new Map<string, ConfirmPolicy>([['locked_tool', 'deny']]);
    const { handler, io } = makeInteractive({ policies });
    const decision = await handler.ask({
      tool: 'locked_tool',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('policy-deny');
    expect(io.promptCount).toBe(0);
  });

  test('unknown tool falls back to always (prompts)', async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('approve');
    const decision = await handler.ask({
      tool: 'never_heard_of_it',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('user-approved');
    expect(io.promptCount).toBe(1);
  });
});

describe('createInteractiveConfirmHandler — interactive responses', () => {
  test("'y' → approved with user-approved reason", async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('approve');
    const decision = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('user-approved');
    expect(decision.promptShownAt).toBeInstanceOf(Date);
  });

  test("'n' → denied with user-denied reason", async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('deny');
    const decision = await handler.ask({
      tool: 'firestore_delete_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('user-denied');
  });

  test('unknown key → denied (safe default)', async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('unknown');
    const decision = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('user-denied');
  });

  test('timeout → denied with timeout reason', async () => {
    const { handler } = makeInteractive({ timeoutMs: 50 });
    const decision = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('timeout');
  });
});

describe('createInteractiveConfirmHandler — session state', () => {
  test("'a' approves this and future calls to same tool", async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('approve-tool');
    const first = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(first.approved).toBe(true);
    // Second call should NOT prompt
    const second = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(second.approved).toBe(true);
    expect(second.reason).toBe('session-cached-approve');
    expect(io.promptCount).toBe(1); // only the first call prompted
  });

  test("'a' only whitelists the specific tool, not all tools", async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('approve-tool', 'deny');
    await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    // Different tool — should prompt
    const second = await handler.ask({
      tool: 'firestore_delete_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(second.approved).toBe(false);
    expect(io.promptCount).toBe(2);
  });

  test("'D' denies everything for the rest of the session", async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('deny-all');
    const first = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(first.approved).toBe(false);
    expect(first.reason).toBe('user-denied');
    // All subsequent calls denied without prompt
    const second = await handler.ask({
      tool: 'firestore_create_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(second.approved).toBe(false);
    expect(second.reason).toBe('session-cached-deny');
    const third = await handler.ask({
      tool: 'never_heard_of_it',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(third.approved).toBe(false);
    expect(third.reason).toBe('session-cached-deny');
    expect(io.promptCount).toBe(1);
  });
});

describe('createInteractiveConfirmHandler — concurrency', () => {
  test('concurrent prompts queue (one at a time)', async () => {
    const { handler, io } = makeInteractive();
    // Don't queue any keys yet — let both prompts go pending.
    const p1 = handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    const p2 = handler.ask({
      tool: 'firestore_delete_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });

    // Wait a tick — only the FIRST prompt should have shown.
    await new Promise((r) => setTimeout(r, 5));
    expect(io.promptCount).toBe(1);

    // Approve the first; the second should now show.
    io.enqueueKeys('approve');
    await p1;
    await new Promise((r) => setTimeout(r, 5));
    expect(io.promptCount).toBe(2);

    io.enqueueKeys('deny');
    const second = await p2;
    expect(second.approved).toBe(false);
  });

  test("if first prompt sets 'D', queued prompts skip prompting", async () => {
    const { handler, io } = makeInteractive();
    const p1 = handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    const p2 = handler.ask({
      tool: 'firestore_delete_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    const p3 = handler.ask({
      tool: 'firestore_deploy_rules',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    io.enqueueKeys('deny-all');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.approved).toBe(false);
    expect(r1.reason).toBe('user-denied');
    expect(r2.approved).toBe(false);
    expect(r2.reason).toBe('session-cached-deny');
    expect(r3.approved).toBe(false);
    expect(r3.reason).toBe('session-cached-deny');
    // Only ONE prompt should have been shown.
    expect(io.promptCount).toBe(1);
  });
});

describe('createInteractiveConfirmHandler — anti-spoof', () => {
  test('asUser is shown when auth.uid is in args', async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('deny');
    await handler.ask({
      tool: 'firestore_update_document',
      args: { auth: { uid: 'user-abc' }, path: 'p', data: {} },
      mode: 'prod',
      project: 'p',
    });
    const promptText = io.writes.join('');
    expect(promptText).toContain('As user:');
    expect(promptText).toContain('user-abc');
  });

  test('asUser is omitted when no auth.uid', async () => {
    const { handler, io } = makeInteractive();
    io.enqueueKeys('deny');
    await handler.ask({
      tool: 'firestore_update_document',
      args: { path: 'p', data: {} },
      mode: 'prod',
      project: 'p',
    });
    const promptText = io.writes.join('');
    expect(promptText).not.toContain('As user:');
  });
});

describe('non-interactive handlers', () => {
  test('createAutoApproveHandler approves everything', async () => {
    const handler = createAutoApproveHandler();
    const decision = await handler.ask({
      tool: 'firestore_delete_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(true);
  });

  test('createDenyAllHandler denies everything with no-tty reason', async () => {
    const handler = createDenyAllHandler();
    const decision = await handler.ask({
      tool: 'firestore_get_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('no-tty');
  });

  test('createPolicyHandler uses allow/deny lists', async () => {
    const handler = createPolicyHandler({
      allow: new Set(['firestore_get_document']),
      deny: new Set(['firestore_delete_document']),
      default: 'deny',
    });
    expect(
      (await handler.ask({ tool: 'firestore_get_document', args: {}, mode: 'prod', project: 'p' }))
        .approved,
    ).toBe(true);
    expect(
      (await handler.ask({ tool: 'firestore_delete_document', args: {}, mode: 'prod', project: 'p' }))
        .approved,
    ).toBe(false);
    expect(
      (await handler.ask({ tool: 'random_tool', args: {}, mode: 'prod', project: 'p' }))
        .approved,
    ).toBe(false); // falls back to default 'deny'
  });

  test('createPolicyHandler with default approve allows unknowns', async () => {
    const handler = createPolicyHandler({
      allow: new Set(),
      default: 'approve',
    });
    expect(
      (await handler.ask({ tool: 'random_tool', args: {}, mode: 'prod', project: 'p' }))
        .approved,
    ).toBe(true);
  });
});

describe('buildPolicyMap + interactive handler integration', () => {
  test('autoApprove override lowers a normally-always tool to never', async () => {
    const policies = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      autoApprove: ['firestore_update_document'],
    });
    const { handler, io } = makeInteractive({ policies });
    const decision = await handler.ask({
      tool: 'firestore_update_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('policy-never');
    expect(io.promptCount).toBe(0);
  });

  test('requireConfirm override raises a normally-never tool to always', async () => {
    const policies = buildPolicyMap(DEFAULT_PROD_POLICIES, {
      requireConfirm: ['firestore_get_document'],
    });
    const { handler, io } = makeInteractive({ policies });
    io.enqueueKeys('approve');
    const decision = await handler.ask({
      tool: 'firestore_get_document',
      args: {},
      mode: 'prod',
      project: 'p',
    });
    expect(io.promptCount).toBe(1);
    expect(decision.approved).toBe(true);
  });
});
