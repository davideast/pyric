/**
 * Sessions module tests. Exercise the public surface end-to-end
 * against an in-memory sandbox (the persistence layer transparently
 * falls back to a memory backend when `indexedDB` is undefined, which
 * is the case under Bun).
 *
 * The tests reach into `disposeSessionsSandbox()` between cases to
 * get an isolated sandbox — the module is built on a singleton, so
 * test cleanup mirrors how a real page reload would reset state.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { disposeSessionsSandbox, getSessionsSandbox } from './sandbox';
import {
  deleteSession,
  loadSession,
  recordSessionRemoteExport,
  saveSession,
  SessionError,
  subscribeSessions,
  type SessionMeta,
  type SessionPayload,
} from './index';

const ALICE = 'sub-alice';

function makePayload(prompt: string): SessionPayload {
  return {
    version: 1,
    workspace: { rules: 'allow read;', code: '', appSource: '' },
    conversation: [{ role: 'user', text: prompt }],
  };
}

async function freshSandbox() {
  disposeSessionsSandbox();
  const sb = getSessionsSandbox();
  await sb.ready;
  return sb;
}

afterEach(() => {
  disposeSessionsSandbox();
});

describe('saveSession + loadSession', () => {
  it('round-trips a fresh session', async () => {
    await freshSandbox();
    const meta = await saveSession(ALICE, {
      id: 's1',
      payload: makePayload('write a todo app'),
    });
    expect(meta.id).toBe('s1');
    expect(meta.userId).toBe(ALICE);
    expect(meta.title).toBe('write a todo app');
    expect(meta.preview).toBe('write a todo app');
    expect(meta.payloadSize).toBeGreaterThan(0);
    expect(meta.createdAt).toBe(meta.updatedAt);

    const loaded = await loadSession(ALICE, 's1');
    expect(loaded.payload.workspace.rules).toBe('allow read;');
    expect(loaded.meta.id).toBe('s1');
  });

  it('preserves createdAt across re-saves and only bumps updatedAt', async () => {
    await freshSandbox();
    const first = await saveSession(ALICE, {
      id: 's2',
      payload: makePayload('first prompt'),
    });
    // Sleep a touch so updatedAt can advance.
    await new Promise((r) => setTimeout(r, 5));
    const second = await saveSession(ALICE, {
      id: 's2',
      payload: makePayload('second prompt'),
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('honors caller-supplied title and preview overrides', async () => {
    await freshSandbox();
    const meta = await saveSession(ALICE, {
      id: 's3',
      title: 'Custom heading',
      preview: 'Custom preview body',
      payload: makePayload('would-be derived title'),
    });
    expect(meta.title).toBe('Custom heading');
    expect(meta.preview).toBe('Custom preview body');
  });

  it('throws not-found when loading a missing session', async () => {
    await freshSandbox();
    let err: unknown;
    try {
      await loadSession(ALICE, 'does-not-exist');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe('not-found');
  });

  it('scopes sessions by userId — bob cannot read alice', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 's4', payload: makePayload('alice secret') });
    let err: unknown;
    try {
      await loadSession('sub-bob', 's4');
    } catch (e) {
      err = e;
    }
    expect((err as SessionError).code).toBe('not-found');
  });

  it('round-trips githubRepo and preserves it across autosaves', async () => {
    await freshSandbox();
    const linked = {
      fullName: 'octocat/firebase-app',
      htmlUrl: 'https://github.com/octocat/firebase-app',
      cloneUrl: 'https://github.com/octocat/firebase-app.git',
      defaultBranch: 'main',
      private: true,
      linkedAt: Date.now(),
    };
    const first = await saveSession(ALICE, {
      id: 's-github',
      payload: makePayload('with github'),
      githubRepo: linked,
    });
    expect(first.githubRepo?.fullName).toBe('octocat/firebase-app');

    const second = await saveSession(ALICE, {
      id: 's-github',
      payload: makePayload('updated prompt'),
    });
    expect(second.githubRepo?.fullName).toBe('octocat/firebase-app');

    const loaded = await loadSession(ALICE, 's-github');
    expect(loaded.meta.githubRepo?.htmlUrl).toBe(linked.htmlUrl);
  });

  it('round-trips sandboxMode and preserves it across autosaves', async () => {
    await freshSandbox();
    const first = await saveSession(ALICE, {
      id: 's-sandbox',
      payload: makePayload('with sandbox mode'),
      sandboxMode: 'shared',
    });
    expect(first.sandboxMode).toBe('shared');

    const second = await saveSession(ALICE, {
      id: 's-sandbox',
      payload: makePayload('autosaved'),
    });
    expect(second.sandboxMode).toBe('shared');

    const changed = await saveSession(ALICE, {
      id: 's-sandbox',
      payload: makePayload('mode changed'),
      sandboxMode: 'isolated',
    });
    expect(changed.sandboxMode).toBe('isolated');

    const loaded = await loadSession(ALICE, 's-sandbox');
    expect(loaded.meta.sandboxMode).toBe('isolated');
  });

  it('keeps legacy sessions without sandboxMode valid', async () => {
    await freshSandbox();
    const meta = await saveSession(ALICE, {
      id: 's-legacy',
      payload: makePayload('legacy'),
    });
    expect(meta.sandboxMode).toBeUndefined();

    const loaded = await loadSession(ALICE, 's-legacy');
    expect(loaded.meta.sandboxMode).toBeUndefined();
  });

  it('round-trips local trace telemetry in the payload', async () => {
    await freshSandbox();
    const payload: SessionPayload = {
      ...makePayload('with traces'),
      conversation: [
        {
          id: 'u1',
          role: 'user',
          text: 'with traces',
          createdAt: 1,
          turnId: 'turn-1',
        },
        {
          id: 'a1',
          role: 'assistant',
          text: 'done',
          createdAt: 2,
          turnId: 'turn-1',
          metrics: { tokensIn: 100, tokensOut: 20, tokensTotal: 120 },
        },
      ],
      telemetry: {
        version: 1,
        capturedAt: 3,
        summary: { turnsWithTraces: 1, requestCount: 1, responseCount: 1 },
        tracesByTurn: {
          'turn-1': {
            turnId: 'turn-1',
            requests: [
              {
                requestId: 'turn-1#0',
                turnId: 'turn-1',
                iteration: 0,
                ts: 4,
                systemPrompt: 'sys',
                messages: [],
                tools: [],
                llm: { id: 'gemini-3.5-flash', supportsTools: true },
              },
            ],
            responses: [
              {
                requestId: 'turn-1#0',
                ts: 5,
                text: 'ok',
                thinking: '',
                toolCalls: [],
              },
            ],
            hostCtx: {
              providerId: 'gemini',
              providerLabel: 'Gemini',
              modelLabel: 'Flash',
              diagnosticsEnabled: false,
              resumableServerMode: false,
            },
          },
        },
      },
    };

    await saveSession(ALICE, { id: 's-telemetry', payload });
    const loaded = await loadSession(ALICE, 's-telemetry');

    expect(loaded.payload.telemetry?.summary.requestCount).toBe(1);
    expect(loaded.payload.telemetry?.tracesByTurn['turn-1']?.requests[0]?.requestId)
      .toBe('turn-1#0');
  });

  it('records remote export metadata without storing remote blobs in the payload', async () => {
    await freshSandbox();
    await saveSession(ALICE, {
      id: 's-export',
      payload: makePayload('export me'),
    });

    const updated = await recordSessionRemoteExport(ALICE, 's-export', {
      exportId: 'export-1',
      status: 'complete',
      projectId: 'demo-project',
      ownerUid: 'owner-1',
      bucketId: 'demo.firebasestorage.app',
      firestoreDocPath: 'pyric/playground/users/owner-1/sessions/s-export/exports/export-1',
      storageManifestPath: 'pyric_sessions/owner-1/s-export/exports/export-1/manifest.json',
      includeFullDetails: true,
      storageBytes: 1234,
      exportedAt: Date.now(),
    });
    expect(updated.remoteExports?.[0]?.exportId).toBe('export-1');

    const afterAutosave = await saveSession(ALICE, {
      id: 's-export',
      payload: makePayload('autosaved after export'),
    });
    expect(afterAutosave.remoteExports?.[0]?.storageManifestPath).toContain('manifest.json');

    const loaded = await loadSession(ALICE, 's-export');
    expect(loaded.meta.remoteExports?.[0]?.exportId).toBe('export-1');
    expect(JSON.stringify(loaded.payload)).not.toContain('manifest.json');
  });
});

describe('deleteSession', () => {
  it('removes the session from subsequent reads', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 's5', payload: makePayload('to be deleted') });
    await deleteSession(ALICE, 's5');
    let err: unknown;
    try {
      await loadSession(ALICE, 's5');
    } catch (e) {
      err = e;
    }
    expect((err as SessionError).code).toBe('not-found');
  });

  it('is idempotent on a missing session', async () => {
    await freshSandbox();
    await expect(deleteSession(ALICE, 'never-saved')).resolves.toBeUndefined();
  });
});

describe('subscribeSessions', () => {
  it('fires once on attach with the existing sessions, then on every change', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 'a', payload: makePayload('alpha') });
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(ALICE, { id: 'b', payload: makePayload('beta') });

    const seen: SessionMeta[][] = [];
    const unsubscribe = subscribeSessions(ALICE, (sessions) => {
      seen.push(sessions);
    });

    // Initial fire happens synchronously on attach.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const initial = seen[seen.length - 1];
    expect(initial.map((s) => s.id).sort()).toEqual(['a', 'b']);

    // A subsequent save triggers another fire.
    await saveSession(ALICE, { id: 'c', payload: makePayload('gamma') });
    await new Promise((r) => setTimeout(r, 10));
    const after = seen[seen.length - 1];
    expect(after.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);

    unsubscribe();
  });

  it('orders sessions most-recent-first by updatedAt', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 'old', payload: makePayload('old') });
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(ALICE, { id: 'mid', payload: makePayload('mid') });
    await new Promise((r) => setTimeout(r, 5));
    await saveSession(ALICE, { id: 'new', payload: makePayload('new') });

    let last: SessionMeta[] = [];
    const unsubscribe = subscribeSessions(ALICE, (sessions) => {
      last = sessions;
    });
    await new Promise((r) => setTimeout(r, 0));
    unsubscribe();
    expect(last.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('strips payload from list snapshots', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 's', payload: makePayload('huge') });
    let last: SessionMeta[] = [];
    const unsubscribe = subscribeSessions(ALICE, (sessions) => {
      last = sessions;
    });
    await new Promise((r) => setTimeout(r, 0));
    unsubscribe();
    // SessionMeta has no `payload` field; verify TS-shape at runtime.
    expect((last[0] as unknown as { payload?: unknown }).payload).toBeUndefined();
  });

  it('removes deleted sessions from the live list', async () => {
    await freshSandbox();
    await saveSession(ALICE, { id: 'keep', payload: makePayload('keep') });
    await saveSession(ALICE, { id: 'drop', payload: makePayload('drop') });

    let last: SessionMeta[] = [];
    const unsubscribe = subscribeSessions(ALICE, (sessions) => {
      last = sessions;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(last.map((s) => s.id).sort()).toEqual(['drop', 'keep']);

    await deleteSession(ALICE, 'drop');
    await new Promise((r) => setTimeout(r, 10));
    expect(last.map((s) => s.id)).toEqual(['keep']);

    unsubscribe();
  });
});
