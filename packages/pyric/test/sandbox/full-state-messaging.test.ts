/**
 * Full-state, checkpoint, and branch round-trip tests for Messaging broker state.
 *
 * Covers active tokens, unregistered tombstones, topic subscriptions, reset of
 * extra state on restore, checkpoint schema validation, fork isolation,
 * cross-service diff, delta promotion, atomic rollback, and on-disk branch store
 * persistence.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from '../../src/sandbox/index.js';
import {
  applyFullState,
  captureFullState,
  type FullSandboxState,
} from '../../src/sandbox/full-state.js';
import {
  captureCheckpoint,
  restoreCheckpoint,
} from '../../src/sandbox/checkpoints/index.js';
import {
  diff,
  fork,
  promote,
} from '../../src/sandbox/branches/index.js';
import {
  branchDirectory,
  loadBranch,
  saveBranch,
} from '../../src/sandbox/branches/store.js';
import { getMessagingBroker } from '../../src/messaging/broker/index.js';
import { getInternalEnv, SandboxImpl } from '../../src/sandbox/internal/sandbox-impl.js';

function hasRegisteredService(sandbox: LocalSandbox, name: string): boolean {
  return (sandbox as SandboxImpl).getServiceRegistry().has(name);
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-messaging-full-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function deliverTopic(sandbox: LocalSandbox, topic: string, recipients: readonly string[]): string[] {
  const broker = getMessagingBroker(sandbox);
  const delivered: string[] = [];
  const unsubscribes = recipients.map((recipient) =>
    broker.onBackgroundMessage(() => {
      delivered.push(recipient);
    }, recipient),
  );
  try {
    broker.send({ topic, data: { note: 'ping' } });
  } finally {
    for (const unsub of unsubscribes) unsub();
  }
  return delivered.sort();
}

describe('Messaging full-state capture and apply', () => {
  it('round-trips active tokens, tombstones, and topic subscriptions and resets extra state', async () => {
    const source = initializeSandbox();
    const sourceBroker = getMessagingBroker(source);
    const activeToken = sourceBroker.getTokenFor('reg-a', 'recipient-a');
    const deletedToken = sourceBroker.getTokenFor('reg-b', 'recipient-b');
    sourceBroker.subscribeToTopic([activeToken, deletedToken], 'news');
    sourceBroker.deleteTokenFor('reg-b');

    const captured = await captureFullState(source);
    expect(captured.messaging).toBeDefined();

    // Mutate after capture so restore must remove the extra token and topic.
    const extraToken = sourceBroker.getTokenFor('reg-c', 'recipient-c');
    sourceBroker.subscribeToTopic([extraToken], 'alerts');
    sourceBroker.unsubscribeFromTopic([activeToken], 'news');

    await applyFullState(source, captured);

    expect(sourceBroker.getTokenFor('reg-a', 'recipient-a')).toBe(activeToken);
    expect(sourceBroker.tokenState(deletedToken)).toBe('unregistered');
    expect(sourceBroker.tokenState(extraToken)).toBe('unknown');
    expect(deliverTopic(source, 'news', ['recipient-a', 'recipient-b', 'recipient-c'])).toEqual([
      'recipient-a',
    ]);
    expect(deliverTopic(source, 'alerts', ['recipient-c'])).toEqual([]);

    // Deleted tombstone must remain rejected for direct sends and topic subscribe.
    let sendError: { errorCode?: string } | null = null;
    try {
      sourceBroker.send({ token: deletedToken, data: { k: 'v' } });
    } catch (error) {
      sendError = error as { errorCode?: string };
    }
    expect(sendError?.errorCode).toBe('UNREGISTERED');
    const subOutcome = sourceBroker.subscribeToTopic([deletedToken], 'news');
    expect(subOutcome.failureCount).toBe(1);
    expect(subOutcome.errors[0]?.reason).toBe('unregistered-token');
  });

  it('omits messaging when unused and resets existing messaging state when restoring empty state', async () => {
    const empty = initializeSandbox();
    const emptyState = await captureFullState(empty);
    expect(emptyState.messaging).toBeUndefined();
    expect(hasRegisteredService(empty, 'messaging')).toBe(false);

    const populated = initializeSandbox();
    const broker = getMessagingBroker(populated);
    const tok = broker.getTokenFor('reg-1', 'r-1');
    broker.subscribeToTopic([tok], 'updates');

    await applyFullState(populated, emptyState);

    expect(broker.tokenState(tok)).toBe('unknown');
    expect(deliverTopic(populated, 'updates', ['r-1'])).toEqual([]);
  });

  it('captures and clears pending unconsumed messaging snapshot loaded via loadSnapshot', async () => {
    const origin = initializeSandbox();
    const originBroker = getMessagingBroker(origin);
    const tok = originBroker.getTokenFor('reg-pending', 'r-pending');
    originBroker.subscribeToTopic([tok], 'pending-topic');
    const blob = origin.snapshot();

    const receiver = initializeSandbox();
    receiver.loadSnapshot(blob);
    // Broker has not been instantiated yet; captureFullState should read pending snapshot.
    expect(hasRegisteredService(receiver, 'messaging')).toBe(false);
    const captured = await captureFullState(receiver);
    expect(captured.messaging).toBeDefined();
    expect(hasRegisteredService(receiver, 'messaging')).toBe(false);

    const restored = initializeSandbox();
    await applyFullState(restored, captured);
    expect(getMessagingBroker(restored).getTokenFor('reg-pending', 'r-pending')).toBe(tok);
    expect(deliverTopic(restored, 'pending-topic', ['r-pending'])).toEqual(['r-pending']);

    // Applying an empty full state onto receiver clears its pending messaging snapshot.
    const emptyState = await captureFullState(initializeSandbox());
    await applyFullState(receiver, emptyState);
    expect(getMessagingBroker(receiver).tokenState(tok)).toBe('unknown');
  });
});

describe('Messaging checkpoints', () => {
  it('captures and restores Messaging state through checkpoints', async () => {
    const sandbox = initializeSandbox();
    const broker = getMessagingBroker(sandbox);
    const keepToken = broker.getTokenFor('reg-keep', 'r-keep');
    const deadToken = broker.getTokenFor('reg-dead', 'r-dead');
    broker.subscribeToTopic([keepToken], 'releases');
    broker.deleteTokenFor('reg-dead');

    const checkpoint = await captureCheckpoint(sandbox);

    const addedToken = broker.getTokenFor('reg-added', 'r-added');
    broker.subscribeToTopic([addedToken], 'releases');
    broker.unsubscribeFromTopic([keepToken], 'releases');

    await restoreCheckpoint(sandbox, checkpoint);

    expect(broker.getTokenFor('reg-keep', 'r-keep')).toBe(keepToken);
    expect(broker.tokenState(deadToken)).toBe('unregistered');
    expect(broker.tokenState(addedToken)).toBe('unknown');
    expect(deliverTopic(sandbox, 'releases', ['r-keep', 'r-added'])).toEqual(['r-keep']);
  });

  it('rejects malformed messaging checkpoint payloads before modifying live state', async () => {
    const sandbox = initializeSandbox();
    const broker = getMessagingBroker(sandbox);
    const liveToken = broker.getTokenFor('reg-live', 'r-live');
    broker.subscribeToTopic([liveToken], 'live-topic');

    const valid = await captureCheckpoint(sandbox);
    const malformed = {
      ...valid,
      state: {
        ...valid.state,
        messaging: { version: 1, tokens: [['bad-token-shape', { registrationId: '', recipientId: '', state: 'bogus' }]], topics: [] },
      },
    };

    let caught: unknown;
    try {
      await restoreCheckpoint(sandbox, malformed as unknown as typeof valid);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(broker.getTokenFor('reg-live', 'r-live')).toBe(liveToken);
    expect(deliverTopic(sandbox, 'live-topic', ['r-live'])).toEqual(['r-live']);
  });
});

describe('Messaging branches, promotion, rollback, and disk persistence', () => {
  it('forks, diffs, and delta-promotes Messaging changes without clobbering concurrent target tokens', async () => {
    const target = initializeSandbox();
    const targetBroker = getMessagingBroker(target);
    const sharedToken = targetBroker.getTokenFor('reg-shared', 'r-shared');
    targetBroker.subscribeToTopic([sharedToken], 'shared-topic');

    const base = await captureFullState(target);
    const branch = await fork(base);
    const branchBroker = getMessagingBroker(branch.sandbox);

    // Fork inherits active token and subscription cleanly.
    expect(branchBroker.getTokenFor('reg-shared', 'r-shared')).toBe(sharedToken);
    expect(deliverTopic(branch.sandbox, 'shared-topic', ['r-shared'])).toEqual(['r-shared']);

    // Mutate the branch: add a new token, subscribe it, and delete sharedToken.
    const branchToken = branchBroker.getTokenFor('reg-branch', 'r-branch');
    branchBroker.subscribeToTopic([branchToken], 'branch-topic');
    branchBroker.deleteTokenFor('reg-shared');

    // Target must stay isolated before promotion, and acquires its own concurrent token.
    expect(targetBroker.tokenState(sharedToken)).toBe('active');
    const concurrentToken = targetBroker.getTokenFor('reg-target-only', 'r-target-only');
    targetBroker.subscribeToTopic([concurrentToken], 'target-only-topic');

    const divergences = await diff(branch, base);
    const messagingDivergences = divergences.filter((entry) => entry.service === 'messaging');
    expect(messagingDivergences.length).toBeGreaterThanOrEqual(3);
    expect(messagingDivergences.some((entry) => entry.path === `tokens/${branchToken}`)).toBe(true);
    expect(messagingDivergences.some((entry) => entry.path === `tokens/${sharedToken}`)).toBe(true);
    expect(
      messagingDivergences.some(
        (entry) => entry.path === 'topics/branch-topic' && entry.field === branchToken,
      ),
    ).toBe(true);

    await promote(branch, target);

    // Branch changes landed.
    expect(targetBroker.getTokenFor('reg-branch', 'r-branch')).toBe(branchToken);
    expect(targetBroker.tokenState(sharedToken)).toBe('unregistered');
    expect(deliverTopic(target, 'branch-topic', ['r-branch'])).toEqual(['r-branch']);
    // Concurrent untouched target state survived delta promotion.
    expect(targetBroker.getTokenFor('reg-target-only', 'r-target-only')).toBe(concurrentToken);
    expect(deliverTopic(target, 'target-only-topic', ['r-target-only'])).toEqual([
      'r-target-only',
    ]);
  });

  it('rolls back Messaging changes atomically when promote fails on a later service', async () => {
    const target = initializeSandbox();
    const targetBroker = getMessagingBroker(target);
    const originalToken = targetBroker.getTokenFor('reg-orig', 'r-orig');
    targetBroker.subscribeToTopic([originalToken], 'orig-topic');

    const base = await captureFullState(target);
    const candidateRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\n');
    const branch = await fork(base, candidateRules);
    const branchBroker = getMessagingBroker(branch.sandbox);
    const extraToken = branchBroker.getTokenFor('reg-extra', 'r-extra');
    branchBroker.subscribeToTopic([extraToken], 'extra-topic');
    branchBroker.deleteTokenFor('reg-orig');

    // Inject a failure during promoteRules (which runs AFTER promoteMessaging).
    const targetEnv = getInternalEnv(target);
    const realDeployRules = targetEnv.deployRules.bind(targetEnv);
    const refusal = new Error('rules deploy refused after messaging promotion');
    targetEnv.deployRules = () => {
      throw refusal;
    };

    let caught: unknown;
    try {
      await promote(branch, target);
    } catch (err) {
      caught = err;
    } finally {
      targetEnv.deployRules = realDeployRules;
    }
    expect(caught).toBe(refusal);
    expect(branch.discarded).toBe(false);

    // Target Messaging state must be rolled back to its pre-promotion state.
    expect(targetBroker.getTokenFor('reg-orig', 'r-orig')).toBe(originalToken);
    expect(targetBroker.tokenState(originalToken)).toBe('active');
    expect(targetBroker.tokenState(extraToken)).toBe('unknown');
    expect(deliverTopic(target, 'orig-topic', ['r-orig'])).toEqual(['r-orig']);
    expect(deliverTopic(target, 'extra-topic', ['r-extra'])).toEqual([]);
  });

  it('persists and reloads messaging.json in the on-disk branch store and removes stale file when cleared', async () => {
    const projectDir = makeTempDir();
    const source = initializeSandbox();
    const broker = getMessagingBroker(source);
    const tok = broker.getTokenFor('reg-disk', 'r-disk');
    broker.subscribeToTopic([tok], 'disk-topic');

    const base: FullSandboxState = await captureFullState(source);
    const branch = await fork(base);
    await saveBranch(projectDir, 'msg-branch', branch, { base: 'live' });

    const dir = branchDirectory(projectDir, 'msg-branch');
    expect(existsSync(join(dir, 'base', 'messaging.json'))).toBe(true);
    expect(existsSync(join(dir, 'state', 'messaging.json'))).toBe(true);

    const loaded = await loadBranch(projectDir, 'msg-branch');
    expect(loaded).not.toBeNull();
    if (loaded === null) throw new Error('Expected saved branch to load');
    const loadedBroker = getMessagingBroker(loaded.branch.sandbox);
    expect(loadedBroker.getTokenFor('reg-disk', 'r-disk')).toBe(tok);
    expect(deliverTopic(loaded.branch.sandbox, 'disk-topic', ['r-disk'])).toEqual(['r-disk']);

    // Clearing Messaging state in the branch and re-saving removes stale state/messaging.json.
    loadedBroker.reset();
    await saveBranch(projectDir, 'msg-branch', loaded.branch, { base: 'live' });
    expect(existsSync(join(dir, 'state', 'messaging.json'))).toBe(false);

    const reloaded = await loadBranch(projectDir, 'msg-branch');
    expect(reloaded).not.toBeNull();
    if (reloaded === null) throw new Error('Expected re-saved branch to load');
    expect((await captureFullState(reloaded.branch.sandbox)).messaging).toBeUndefined();
  });
});
