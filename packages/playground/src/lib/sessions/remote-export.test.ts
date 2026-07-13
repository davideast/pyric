import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '~/lib/store/chat';
import type { TurnTrace } from '~/lib/store/trace';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';
import {
  REMOTE_EXPORT_SCHEMA_VERSION,
  buildManifestArtifact,
  buildRemoteExportArtifacts,
  buildRemoteExportRequestRows,
  exportSessionToFirebase,
  remoteExportPaths,
  storageObjectCustomMetadata,
  type RemoteExportArtifact,
  type RemoteExportAdapters,
  type RemoteExportIdentity,
  type RemoteExportInput,
  type UploadedRemoteExportArtifact,
} from './remote-export';

const encoder = new TextEncoder();

const messages: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    text: 'Build a SECRET pizza app',
    createdAt: 1,
  },
  {
    id: 'a1',
    role: 'assistant',
    text: 'Done',
    createdAt: 2,
    turnId: 'turn-1',
    toolCalls: [
      {
        id: 'tool-1',
        name: 'write_file',
        argsJson: '{"path":"/workspace/src/App.tsx","content":"SECRET"}',
        resultJson: '{"ok":true}',
      },
    ],
    metrics: {
      tokensIn: 100,
      tokensOut: 20,
      tokensTotal: 120,
      cachedTokens: 10,
      reasoningTokens: 5,
    },
  },
];

const tracesByTurn: Record<string, TurnTrace> = {
  'turn-1': {
    turnId: 'turn-1',
    hostCtx: {
      providerId: 'gemini',
      providerLabel: 'Gemini',
      modelLabel: 'Gemini 3.5 Flash',
      diagnosticsEnabled: true,
      resumableServerMode: false,
    },
    requests: [
      {
        requestId: 'turn-1#0',
        turnId: 'turn-1',
        iteration: 0,
        ts: 10,
        systemPrompt: 'system',
        messages: [
          { role: 'system', text: 'system' },
          { role: 'user', text: 'Build a SECRET pizza app' },
          {
            role: 'assistant',
            text: 'Thinking',
            toolCalls: [{ name: 'write_file', args: { content: 'SECRET' } }],
          },
          { role: 'tool', resultJson: '{"ok":true,"secret":"SECRET"}' },
        ],
        tools: [{ name: 'write_file', description: 'write', parameters: {} }],
      } as never,
    ],
    responses: [
      {
        requestId: 'turn-1#0',
        text: 'Done',
        thinking: 'internal',
        usage: { promptTokens: 100, outputTokens: 20, cachedTokens: 10 },
      } as never,
    ],
  },
};

const contextSnapshot: ContextWindowSnapshot = {
  basis: 'estimated-next-send',
  usedTokens: 100,
  limitTokens: 1000,
  percentFull: 0.1,
  status: 'low',
  breakdown: [
    { id: 'system', label: 'System prompt', tokens: 10, color: '#fff', estimated: true },
    { id: 'history', label: 'Conversation', tokens: 90, color: '#aaa', estimated: true },
  ],
  compaction: {
    compacted: false,
    originalChars: 0,
    compactedChars: 0,
    bytesSaved: 0,
    turnsCompacted: 0,
    messagesCompacted: 0,
  },
  compactionPreview: {
    rawTokens: 100,
    currentTokens: 100,
    compactedTokens: 100,
    automaticSavedTokens: 0,
    manualSavedTokens: 0,
    savedTokens: 0,
    stats: {
      compacted: false,
      originalChars: 0,
      compactedChars: 0,
      bytesSaved: 0,
      turnsCompacted: 0,
      messagesCompacted: 0,
    },
    retains: [],
    loses: [],
  },
  pricing: { current: null, compacted: null, savedCostUsd: null },
  toolCount: 1,
  sessionUsage: {
    turns: 1,
    requests: 1,
    tokensTotal: 120,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    reasoningTokens: 5,
    workMultiplier: 1.2,
    averageRequestTokens: 120,
    turnRows: [
      {
        id: 'a1',
        label: 'Turn 1',
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 10,
        reasoningTokens: 5,
        freshInputTokens: 90,
        visibleOutputTokens: 15,
        tokensTotal: 120,
        multiplierContribution: 1.2,
      },
    ],
    requestRows: [],
    categoryDetails: {},
    teachingNotes: {
      providerUsage: 'Provider usage totals are authoritative for input, cache, output, and reasoning when the provider reports them.',
      estimatedComposition: 'Source-level input slices are estimated from saved provider-visible request traces using the chars/4 token estimator.',
      contextVsSpend: 'The context window is one next request; session spend is every provider request already made.',
    },
  },
};

function baseInput(includeFullDetails: boolean): RemoteExportInput {
  return {
    sessionId: 'session-1',
    projectId: 'demo-project',
    accessToken: 'token',
    includeFullDetails,
    workspace: {
      rules: 'rules SECRET',
      appSource: 'app SECRET',
      code: '',
    },
    messages,
    tracesByTurn,
    contextSnapshot,
    firebaseConfig: {
      apiKey: 'api',
      authDomain: 'demo.firebaseapp.com',
      projectId: 'demo-project',
      appId: 'app',
      storageBucket: 'demo.firebasestorage.app',
    },
  };
}

function fixedAdapters(extra: Partial<RemoteExportAdapters> = {}): RemoteExportAdapters {
  return {
    now: () => 1_700_000_000_000,
    createExportId: () => 'export-1',
    prepareProjectContext: async () => ({
      ownerUid: 'owner-1',
      bucketId: 'demo.firebasestorage.app',
      accessToken: 'test-access-token',
    }),
    gzipText: async (text: string) => encoder.encode(`gz:${text}`),
    sha256Bytes: async (bytes: Uint8Array) => `sha-${bytes.byteLength}`,
    ...extra,
  };
}

describe('remote export paths and artifacts', () => {
  test('links the same ids across Firestore path, Storage path, and metadata', () => {
    const identity: RemoteExportIdentity = {
      schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
      sessionId: 'session-1',
      exportId: 'export-1',
      ownerUid: 'owner-1',
      projectId: 'demo-project',
      bucketId: 'demo.firebasestorage.app',
      createdAt: 1,
    };
    const paths = remoteExportPaths(identity);

    expect(paths.firestoreDocPath).toBe(
      'pyric/playground/users/owner-1/sessions/session-1/exports/export-1',
    );
    expect(paths.storagePrefix).toBe(
      'pyric_sessions/owner-1/session-1/exports/export-1',
    );
    expect(paths.storageManifestPath).toBe(
      'pyric_sessions/owner-1/session-1/exports/export-1/manifest.json',
    );
    expect(storageObjectCustomMetadata(identity, paths, 'traces')).toEqual({
      sessionId: 'session-1',
      exportId: 'export-1',
      ownerUid: 'owner-1',
      schemaVersion: '1',
      artifactKind: 'traces',
      firestoreDocPath: paths.firestoreDocPath,
    });
  });

  test('manifest carries artifact byte counts and hashes', async () => {
    const identity: RemoteExportIdentity = {
      schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
      sessionId: 'session-1',
      exportId: 'export-1',
      ownerUid: 'owner-1',
      projectId: 'demo-project',
      bucketId: 'demo.firebasestorage.app',
      createdAt: 1,
    };
    const paths = remoteExportPaths(identity);
    const uploaded: UploadedRemoteExportArtifact[] = [
      {
        kind: 'conversation',
        filename: 'conversation.json.gz',
        path: `${paths.storagePrefix}/conversation.json.gz`,
        contentType: 'application/json',
        contentEncoding: 'gzip',
        size: 42,
        sha256: 'sha-42',
        generation: '7',
      },
    ];

    const manifest = await buildManifestArtifact({
      identity,
      paths,
      uploadedArtifacts: uploaded,
      sha256Bytes: async (bytes) => `sha-${bytes.byteLength}`,
    });
    const parsed = JSON.parse(new TextDecoder().decode(manifest.bytes));

    expect(parsed.firestoreDocPath).toBe(paths.firestoreDocPath);
    expect(parsed.artifacts[0].sha256).toBe('sha-42');
    expect(manifest.sha256).toBe(`sha-${manifest.bytes.byteLength}`);
  });
});

describe('exportSessionToFirebase', () => {
  test('summary-only export writes Firestore and does not upload Storage blobs', async () => {
    const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
    let uploads = 0;
    const result = await exportSessionToFirebase(baseInput(false), fixedAdapters({
      putFirestoreDocument: async ({ docPath, data }) => {
        writes.push({ path: docPath, data });
      },
      uploadStorageObject: async () => {
        uploads += 1;
        throw new Error('should not upload');
      },
    }));

    expect(result.ok).toBe(true);
    expect(uploads).toBe(0);
    expect(writes[0]!.path).toBe('pyric/playground/users/owner-1/sessions/session-1/exports/export-1');
    expect(writes.some((w) => w.path.endsWith('/turns/a1'))).toBe(true);
    expect(writes.some((w) => w.path.endsWith('/requests/turn-1_230'))).toBe(true);
    expect(writes.at(-1)!.data.status).toBe('complete');
    expect(JSON.stringify(writes)).not.toContain('SECRET');
  });

  test('full export uploads details while Firestore summaries stay raw-free', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const uploads: RemoteExportArtifact[] = [];
    const result = await exportSessionToFirebase(baseInput(true), fixedAdapters({
      putFirestoreDocument: async ({ data }) => {
        writes.push(data);
      },
      uploadStorageObject: async ({ artifact }) => {
        uploads.push(artifact);
        return {
          kind: artifact.kind,
          filename: artifact.filename,
          path: artifact.path,
          contentType: artifact.contentType,
          ...(artifact.contentEncoding ? { contentEncoding: artifact.contentEncoding } : {}),
          size: artifact.size,
          sha256: artifact.sha256,
          generation: `gen-${uploads.length}`,
        };
      },
    }));

    expect(result.ok).toBe(true);
    expect(uploads.map((artifact) => artifact.filename)).toEqual([
      'telemetry-full.json.gz',
      'traces.ndjson.gz',
      'request-ledger.ndjson.gz',
      'conversation.json.gz',
      'workspace.json.gz',
      'manifest.json',
    ]);
    expect(JSON.stringify(writes)).not.toContain('SECRET');
    expect(result.ok && result.storageManifestPath).toBe(
      'pyric_sessions/owner-1/session-1/exports/export-1/manifest.json',
    );
    // Summary doc must stay under Firestore's 1 MiB limit: the unbounded
    // per-turn/per-request arrays are dropped (they live in `turns/` + Storage),
    // while the scalar totals are kept.
    const summary = writes.find((d) => (d as { context?: unknown }).context) as {
      context?: { sessionUsage?: Record<string, unknown> };
    };
    expect(summary?.context?.sessionUsage).toBeDefined();
    expect(summary?.context?.sessionUsage?.turnRows).toBeUndefined();
    expect(summary?.context?.sessionUsage?.requestRows).toBeUndefined();
    expect(summary?.context?.sessionUsage?.tokensTotal).toBeDefined();
  });

  test('Firestore pending failure prevents Storage upload', async () => {
    let uploads = 0;
    const result = await exportSessionToFirebase(baseInput(true), fixedAdapters({
      putFirestoreDocument: async () => {
        throw new Error('firestore down');
      },
      uploadStorageObject: async () => {
        uploads += 1;
        throw new Error('should not upload');
      },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('firestore-write-failed');
    expect(uploads).toBe(0);
  });

  test('Storage failure marks the export failed and returns local metadata', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const result = await exportSessionToFirebase(baseInput(true), fixedAdapters({
      putFirestoreDocument: async ({ data }) => {
        writes.push(data);
      },
      uploadStorageObject: async () => {
        throw new Error('storage denied');
      },
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('storage-upload-failed');
    expect(writes.at(-1)!.status).toBe('failed');
    expect(result.localMeta?.status).toBe('failed');
    expect(result.localMeta?.storageManifestPath).toBe(
      'pyric_sessions/owner-1/session-1/exports/export-1/manifest.json',
    );
  });

  test('real REST writes: Firestore PATCH + Storage POST/PATCH with the access token', async () => {
    const calls: Array<{ url: string; method: string; auth: boolean }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method, auth: !!headers.Authorization });
      if (u.includes('firebasestorage.googleapis.com') && method === 'POST') {
        return new Response(JSON.stringify({ size: '9', generation: 'g1', md5Hash: 'm1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 }); // storage PATCH + firestore PATCH
    }) as typeof fetch;
    try {
      // No put/upload overrides -> the REAL REST code paths run against the stub.
      const result = await exportSessionToFirebase(baseInput(true), fixedAdapters());
      const storagePost = calls.filter((c) => c.url.includes('firebasestorage.googleapis.com') && c.method === 'POST');
      const storagePatch = calls.filter((c) => c.url.includes('firebasestorage.googleapis.com') && c.method === 'PATCH');
      const firestore = calls.filter((c) => c.url.includes('firestore.googleapis.com'));
      expect(result.ok).toBe(true);
      expect(storagePost.length).toBeGreaterThan(0);
      expect(storagePost[0]!.url).toContain('/b/demo.firebasestorage.app/o?name=');
      expect(storagePost.every((c) => c.auth)).toBe(true);
      expect(storagePatch.length).toBeGreaterThan(0); // contentEncoding + customMetadata
      expect(firestore.length).toBeGreaterThan(0);
      expect(firestore.every((c) => c.auth)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('request rows summarize provider-visible requests without raw bodies', () => {
    const rows = buildRemoteExportRequestRows(tracesByTurn);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokensIn).toBe(100);
    expect(rows[0]!.cachedInputTokens).toBe(10);
    expect(rows[0]!.toolNames).toEqual(['write_file']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  test('artifact builder stores full detail payloads only in Storage artifacts', async () => {
    const identity: RemoteExportIdentity = {
      schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
      sessionId: 'session-1',
      exportId: 'export-1',
      ownerUid: 'owner-1',
      projectId: 'demo-project',
      bucketId: 'demo.firebasestorage.app',
      createdAt: 1,
    };
    const artifacts = await buildRemoteExportArtifacts({
      identity,
      paths: remoteExportPaths(identity),
      input: baseInput(true),
      requestRows: buildRemoteExportRequestRows(tracesByTurn),
      gzipText: async (text) => encoder.encode(text),
      sha256Bytes: async (bytes) => `sha-${bytes.byteLength}`,
    });

    const conversation = artifacts.find((artifact) => artifact.kind === 'conversation')!;
    expect(new TextDecoder().decode(conversation.bytes)).toContain('SECRET');
    expect(conversation.sha256).toBe(`sha-${conversation.bytes.byteLength}`);
  });
});
