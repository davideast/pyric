// This flow writes to the TARGET project entirely over REST using the caller's
// Google access token — no Firebase app/auth/storage SDK. Firestore summary
// rows go via the Firestore REST API; Storage artifacts via the Firebase
// Storage REST endpoint (firebasestorage.googleapis.com/v0), both authorized by
// the cloud-platform Bearer token (admin, rules-bypassed). This is why any
// credential source works (pyric login / ADC / GIS) — no token-audience /
// Firebase-Auth-sign-in dependency.
import type { ChatMessage } from '~/lib/store/chat';
import type { DeployTarget } from '~/lib/store/workspace';
import type { TurnTrace } from '~/lib/store/trace';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';
import {
  collectRequestToolNames,
  estimateRequestInputComposition,
  requestInputCompositionTotal,
  tokenEstimate,
} from '~/lib/agent/request-composition';
import {
  fetchWebConfig,
  getFirestoreDatabase,
  listWebApps,
  type FirebaseWebConfig,
} from '~/lib/firebase/management';
import type { SessionRemoteExportMeta } from './types';

const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
export const REMOTE_EXPORT_SCHEMA_VERSION = 1;

export interface RemoteExportWorkspaceSnapshot {
  rules: string;
  appSource: string;
  code?: string;
  deployTarget?: DeployTarget | null;
}

export interface RemoteExportInput {
  sessionId: string;
  projectId: string;
  accessToken: string;
  includeFullDetails: boolean;
  workspace: RemoteExportWorkspaceSnapshot;
  messages: readonly ChatMessage[];
  tracesByTurn: Record<string, TurnTrace>;
  contextSnapshot?: ContextWindowSnapshot;
  firebaseConfig?: FirebaseWebConfig | DeployTarget['firebaseConfig'] | null;
}

export interface RemoteExportIdentity {
  schemaVersion: 1;
  sessionId: string;
  exportId: string;
  ownerUid: string;
  projectId: string;
  bucketId: string;
  createdAt: number;
}

export interface RemoteExportPaths {
  firestoreDocPath: string;
  storagePrefix: string;
  storageManifestPath: string;
}

export interface RemoteExportArtifact {
  kind:
    | 'telemetry-full'
    | 'traces'
    | 'request-ledger'
    | 'conversation'
    | 'workspace'
    | 'manifest';
  filename: string;
  path: string;
  contentType: string;
  contentEncoding?: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

export interface UploadedRemoteExportArtifact {
  kind: RemoteExportArtifact['kind'];
  filename: string;
  path: string;
  contentType: string;
  contentEncoding?: string;
  size: number;
  sha256: string;
  generation?: string;
  md5Hash?: string;
}

export interface RemoteExportProjectContext {
  ownerUid: string;
  bucketId: string;
  /** The caller's Google access token — used for the Storage REST uploads. */
  accessToken: string;
}

export interface RemoteExportRequestRow {
  requestId: string;
  turnId: string;
  iteration: number;
  ts?: number;
  providerId?: string;
  providerLabel?: string;
  modelLabel?: string;
  strategy?: string;
  strategySource?: string;
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  usageSource: 'provider' | 'estimate';
  composition: {
    system: number;
    history: number;
    resentToolResults: number;
    currentPrompt: number;
    toolSchemas: number;
  };
  messageCount: number;
  toolResultMessageCount: number;
  toolNames: string[];
}

export interface RemoteExportSummaryDoc {
  schemaVersion: 1;
  status: 'pending' | 'complete' | 'failed';
  sessionId: string;
  exportId: string;
  ownerUid: string;
  projectId: string;
  bucketId: string;
  createdAt: number;
  updatedAt: number;
  includeFullDetails: boolean;
  counts: {
    conversationMessages: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    traceTurns: number;
    modelRequests: number;
  };
  workspace: {
    rulesChars: number;
    appSourceChars: number;
    codeChars: number;
  };
  context?: {
    basis: ContextWindowSnapshot['basis'];
    usedTokens: number;
    limitTokens?: number;
    percentFull?: number;
    status: ContextWindowSnapshot['status'];
    breakdown: Array<{ id: string; label: string; tokens: number }>;
    // Trimmed: the unbounded per-turn/per-request arrays are dropped to keep
    // the summary doc under Firestore's 1 MiB limit (full rows live in the
    // `turns/` subcollection + the Storage export). Scalar totals are kept.
    sessionUsage?: Omit<
      NonNullable<ContextWindowSnapshot['sessionUsage']>,
      'turnRows' | 'requestRows'
    >;
  };
  storage?: {
    bucketId: string;
    prefix: string;
    manifestPath: string;
    artifacts: UploadedRemoteExportArtifact[];
    bytesTotal: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export type RemoteExportResult =
  | {
      ok: true;
      exportId: string;
      firestoreDocPath: string;
      storageManifestPath?: string;
      storageArtifacts: UploadedRemoteExportArtifact[];
      localMeta: SessionRemoteExportMeta;
    }
  | {
      ok: false;
      code: string;
      message: string;
      exportId?: string;
      firestoreDocPath?: string;
      storageManifestPath?: string;
      storageArtifacts?: UploadedRemoteExportArtifact[];
      localMeta?: SessionRemoteExportMeta;
    };

export interface PutFirestoreDocumentInput {
  accessToken: string;
  projectId: string;
  docPath: string;
  data: Record<string, unknown>;
}

export interface UploadStorageObjectInput {
  context: RemoteExportProjectContext;
  artifact: RemoteExportArtifact;
  metadata: Record<string, string>;
}

export interface RemoteExportAdapters {
  now?: () => number;
  createExportId?: () => string;
  prepareProjectContext?: (input: RemoteExportInput) => Promise<RemoteExportProjectContext>;
  putFirestoreDocument?: (input: PutFirestoreDocumentInput) => Promise<void>;
  uploadStorageObject?: (input: UploadStorageObjectInput) => Promise<UploadedRemoteExportArtifact>;
  gzipText?: (text: string) => Promise<Uint8Array>;
  sha256Bytes?: (bytes: Uint8Array) => Promise<string>;
}

export async function exportSessionToFirebase(
  input: RemoteExportInput,
  adapters: RemoteExportAdapters = {},
): Promise<RemoteExportResult> {
  const now = adapters.now ?? (() => Date.now());
  const createdAt = now();
  const exportId = adapters.createExportId?.() ?? createExportId(createdAt);
  let ctx: RemoteExportProjectContext;
  try {
    ctx = await (adapters.prepareProjectContext ?? prepareProjectContext)(input);
  } catch (e) {
    return failure('project-context-failed', errorMessage(e), exportId);
  }

  const identity: RemoteExportIdentity = {
    schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    exportId,
    ownerUid: ctx.ownerUid,
    projectId: input.projectId,
    bucketId: ctx.bucketId,
    createdAt,
  };
  const paths = remoteExportPaths(identity);
  const requestRows = buildRemoteExportRequestRows(input.tracesByTurn);
  const turnRows = input.contextSnapshot?.sessionUsage?.turnRows ?? [];
  const baseDoc = buildRemoteExportSummaryDoc({
    identity,
    paths,
    input,
    requestRows,
    status: 'pending',
    updatedAt: createdAt,
  });

  const putFirestore = adapters.putFirestoreDocument ?? putFirestoreDocument;
  try {
    await putFirestore({
      accessToken: input.accessToken,
      projectId: input.projectId,
      docPath: paths.firestoreDocPath,
      data: baseDoc as unknown as Record<string, unknown>,
    });
    await Promise.all([
      ...turnRows.map((row) =>
        putFirestore({
          accessToken: input.accessToken,
          projectId: input.projectId,
          docPath: `${paths.firestoreDocPath}/turns/${safeDocId(row.id)}`,
          data: { ...row, schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION },
        }),
      ),
      ...requestRows.map((row) =>
        putFirestore({
          accessToken: input.accessToken,
          projectId: input.projectId,
          docPath: `${paths.firestoreDocPath}/requests/${safeDocId(row.requestId)}`,
          data: { ...row, schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION },
        }),
      ),
    ]);
  } catch (e) {
    return failure('firestore-write-failed', errorMessage(e), exportId, paths.firestoreDocPath);
  }

  let uploaded: UploadedRemoteExportArtifact[] = [];
  if (input.includeFullDetails) {
    try {
      const artifacts = await buildRemoteExportArtifacts({
        identity,
        paths,
        input,
        requestRows,
        gzipText: adapters.gzipText ?? gzipText,
        sha256Bytes: adapters.sha256Bytes ?? sha256Bytes,
      });
      uploaded = [];
      const upload = adapters.uploadStorageObject ?? uploadStorageObject;
      const detailArtifacts = artifacts.filter((artifact) => artifact.kind !== 'manifest');
      for (const artifact of detailArtifacts) {
        uploaded.push(await upload({
          context: ctx,
          artifact,
          metadata: storageObjectCustomMetadata(identity, paths, artifact.kind),
        }));
      }
      const manifest = await buildManifestArtifact({
        identity,
        paths,
        uploadedArtifacts: uploaded,
        sha256Bytes: adapters.sha256Bytes ?? sha256Bytes,
      });
      uploaded.push(await upload({
        context: ctx,
        artifact: manifest,
        metadata: storageObjectCustomMetadata(identity, paths, manifest.kind),
      }));
    } catch (e) {
      const failedAt = now();
      const failedDoc = buildRemoteExportSummaryDoc({
        identity,
        paths,
        input,
        requestRows,
        status: 'failed',
        uploadedArtifacts: uploaded,
        updatedAt: failedAt,
        error: { code: 'storage-upload-failed', message: errorMessage(e) },
      });
      await putFirestore({
        accessToken: input.accessToken,
        projectId: input.projectId,
        docPath: paths.firestoreDocPath,
        data: failedDoc as unknown as Record<string, unknown>,
      }).catch(() => undefined);
      return {
        ok: false,
        code: 'storage-upload-failed',
        message: errorMessage(e),
        exportId,
        firestoreDocPath: paths.firestoreDocPath,
        storageManifestPath: paths.storageManifestPath,
        storageArtifacts: uploaded,
        localMeta: localMetaFor({
          identity,
          paths,
          includeFullDetails: true,
          status: 'failed',
          uploadedArtifacts: uploaded,
          exportedAt: failedAt,
          error: { code: 'storage-upload-failed', message: errorMessage(e) },
        }),
      };
    }
  }

  const completedAt = now();
  const completeDoc = buildRemoteExportSummaryDoc({
    identity,
    paths,
    input,
    requestRows,
    status: 'complete',
    uploadedArtifacts: uploaded,
    updatedAt: completedAt,
  });
  try {
    await putFirestore({
      accessToken: input.accessToken,
      projectId: input.projectId,
      docPath: paths.firestoreDocPath,
      data: completeDoc as unknown as Record<string, unknown>,
    });
  } catch (e) {
    return failure('firestore-complete-failed', errorMessage(e), exportId, paths.firestoreDocPath);
  }

  const localMeta = localMetaFor({
    identity,
    paths,
    includeFullDetails: input.includeFullDetails,
    status: 'complete',
    uploadedArtifacts: uploaded,
    exportedAt: completedAt,
  });
  return {
    ok: true,
    exportId,
    firestoreDocPath: paths.firestoreDocPath,
    ...(input.includeFullDetails ? { storageManifestPath: paths.storageManifestPath } : {}),
    storageArtifacts: uploaded,
    localMeta,
  };
}

export function remoteExportPaths(identity: RemoteExportIdentity): RemoteExportPaths {
  const firestoreDocPath = [
    'pyric',
    'playground',
    'users',
    identity.ownerUid,
    'sessions',
    identity.sessionId,
    'exports',
    identity.exportId,
  ].join('/');
  const storagePrefix = [
    'pyric_sessions',
    identity.ownerUid,
    identity.sessionId,
    'exports',
    identity.exportId,
  ].join('/');
  return {
    firestoreDocPath,
    storagePrefix,
    storageManifestPath: `${storagePrefix}/manifest.json`,
  };
}

/**
 * Drop the unbounded per-turn / per-request arrays from sessionUsage so the
 * Firestore summary doc stays under the 1 MiB document limit. The full rows
 * live in the `turns/` subcollection and the Storage export; the summary keeps
 * the scalar totals + bounded category/teaching fields.
 */
function summarizeSessionUsage(
  su: NonNullable<ContextWindowSnapshot['sessionUsage']>,
): Omit<NonNullable<ContextWindowSnapshot['sessionUsage']>, 'turnRows' | 'requestRows'> {
  const { turnRows: _turnRows, requestRows: _requestRows, ...rest } = su;
  return rest;
}

export function buildRemoteExportSummaryDoc({
  identity,
  paths,
  input,
  requestRows,
  status,
  uploadedArtifacts = [],
  updatedAt,
  error,
}: {
  identity: RemoteExportIdentity;
  paths: RemoteExportPaths;
  input: RemoteExportInput;
  requestRows: readonly RemoteExportRequestRow[];
  status: RemoteExportSummaryDoc['status'];
  uploadedArtifacts?: readonly UploadedRemoteExportArtifact[];
  updatedAt: number;
  error?: { code: string; message: string };
}): RemoteExportSummaryDoc {
  const messages = input.messages;
  const toolCalls = messages.reduce((sum, message) => sum + (message.toolCalls?.length ?? 0), 0);
  const doc: RemoteExportSummaryDoc = {
    schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
    status,
    sessionId: identity.sessionId,
    exportId: identity.exportId,
    ownerUid: identity.ownerUid,
    projectId: identity.projectId,
    bucketId: identity.bucketId,
    createdAt: identity.createdAt,
    updatedAt,
    includeFullDetails: input.includeFullDetails,
    counts: {
      conversationMessages: messages.length,
      userMessages: messages.filter((message) => message.role === 'user').length,
      assistantMessages: messages.filter((message) => message.role === 'assistant').length,
      toolCalls,
      traceTurns: Object.keys(input.tracesByTurn).length,
      modelRequests: requestRows.length,
    },
    workspace: {
      rulesChars: input.workspace.rules.length,
      appSourceChars: input.workspace.appSource.length,
      codeChars: input.workspace.code?.length ?? 0,
    },
  };
  if (input.contextSnapshot) {
    doc.context = {
      basis: input.contextSnapshot.basis,
      usedTokens: input.contextSnapshot.usedTokens,
      ...(input.contextSnapshot.limitTokens !== undefined
        ? { limitTokens: input.contextSnapshot.limitTokens }
        : {}),
      ...(input.contextSnapshot.percentFull !== undefined
        ? { percentFull: input.contextSnapshot.percentFull }
        : {}),
      status: input.contextSnapshot.status,
      breakdown: input.contextSnapshot.breakdown.map((row) => ({
        id: row.id,
        label: row.label,
        tokens: row.tokens,
      })),
      ...(input.contextSnapshot.sessionUsage
        ? { sessionUsage: summarizeSessionUsage(input.contextSnapshot.sessionUsage) }
        : {}),
    };
  }
  if (input.includeFullDetails || uploadedArtifacts.length > 0) {
    doc.storage = {
      bucketId: identity.bucketId,
      prefix: paths.storagePrefix,
      manifestPath: paths.storageManifestPath,
      artifacts: [...uploadedArtifacts],
      bytesTotal: uploadedArtifacts.reduce((sum, artifact) => sum + artifact.size, 0),
    };
  }
  if (error) doc.error = error;
  return doc;
}

export async function buildRemoteExportArtifacts({
  identity,
  paths,
  input,
  requestRows,
  gzipText: compress,
  sha256Bytes: hash,
}: {
  identity: RemoteExportIdentity;
  paths: RemoteExportPaths;
  input: RemoteExportInput;
  requestRows: readonly RemoteExportRequestRow[];
  gzipText: (text: string) => Promise<Uint8Array>;
  sha256Bytes: (bytes: Uint8Array) => Promise<string>;
}): Promise<RemoteExportArtifact[]> {
  const telemetryFull = {
    identity,
    paths,
    context: input.contextSnapshot ?? null,
    summary: buildRemoteExportSummaryDoc({
      identity,
      paths,
      input,
      requestRows,
      status: 'complete',
      updatedAt: identity.createdAt,
    }),
    turns: input.contextSnapshot?.sessionUsage?.turnRows ?? [],
    requests: requestRows,
  };
  const traceLines = Object.values(input.tracesByTurn)
    .map((trace) => JSON.stringify(trace))
    .join('\n');
  const ledgerLines = requestRows.map((row) => JSON.stringify(row)).join('\n');
  const entries: Array<{
    kind: RemoteExportArtifact['kind'];
    filename: string;
    value: unknown;
    ndjson?: string;
  }> = [
    { kind: 'telemetry-full', filename: 'telemetry-full.json.gz', value: telemetryFull },
    { kind: 'traces', filename: 'traces.ndjson.gz', value: null, ndjson: traceLines },
    { kind: 'request-ledger', filename: 'request-ledger.ndjson.gz', value: null, ndjson: ledgerLines },
    { kind: 'conversation', filename: 'conversation.json.gz', value: input.messages },
    { kind: 'workspace', filename: 'workspace.json.gz', value: input.workspace },
  ];
  const artifacts: RemoteExportArtifact[] = [];
  for (const entry of entries) {
    const raw = entry.ndjson ?? stableJson(entry.value);
    const bytes = await compress(raw);
    artifacts.push({
      kind: entry.kind,
      filename: entry.filename,
      path: `${paths.storagePrefix}/${entry.filename}`,
      contentType: 'application/json',
      contentEncoding: 'gzip',
      bytes,
      size: bytes.byteLength,
      sha256: await hash(bytes),
    });
  }
  return artifacts;
}

export async function buildManifestArtifact({
  identity,
  paths,
  uploadedArtifacts,
  sha256Bytes: hash,
}: {
  identity: RemoteExportIdentity;
  paths: RemoteExportPaths;
  uploadedArtifacts: readonly UploadedRemoteExportArtifact[];
  sha256Bytes: (bytes: Uint8Array) => Promise<string>;
}): Promise<RemoteExportArtifact> {
  const manifest = {
    schemaVersion: REMOTE_EXPORT_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    exportId: identity.exportId,
    ownerUid: identity.ownerUid,
    projectId: identity.projectId,
    bucketId: identity.bucketId,
    createdAt: identity.createdAt,
    firestoreDocPath: paths.firestoreDocPath,
    storagePrefix: paths.storagePrefix,
    artifacts: uploadedArtifacts,
  };
  const bytes = new TextEncoder().encode(stableJson(manifest));
  return {
    kind: 'manifest',
    filename: 'manifest.json',
    path: paths.storageManifestPath,
    contentType: 'application/json',
    bytes,
    size: bytes.byteLength,
    sha256: await hash(bytes),
  };
}

export function storageObjectCustomMetadata(
  identity: RemoteExportIdentity,
  paths: RemoteExportPaths,
  artifactKind: RemoteExportArtifact['kind'],
): Record<string, string> {
  return {
    sessionId: identity.sessionId,
    exportId: identity.exportId,
    ownerUid: identity.ownerUid,
    schemaVersion: String(identity.schemaVersion),
    artifactKind,
    firestoreDocPath: paths.firestoreDocPath,
  };
}

export function buildRemoteExportRequestRows(
  tracesByTurn: Record<string, TurnTrace>,
): RemoteExportRequestRow[] {
  const rows: RemoteExportRequestRow[] = [];
  for (const trace of Object.values(tracesByTurn)) {
    trace.requests.forEach((req, index) => {
      const request = req as RequestTraceLike;
      const response = trace.responses[index] as ResponseTraceLike | undefined;
      const composition = estimateRequestInputComposition(request);
      const usage = response?.usage;
      const tokensIn = nonNegative(usage?.promptTokens) ?? requestInputCompositionTotal(composition);
      const tokensOut =
        nonNegative(usage?.outputTokens) ??
        tokenEstimate(response?.text) + tokenEstimate(response?.thinking);
      rows.push({
        requestId: request.requestId ?? `${trace.turnId}#${request.iteration ?? index}`,
        turnId: request.turnId ?? trace.turnId,
        iteration: request.iteration ?? index,
        ...(typeof request.ts === 'number' ? { ts: request.ts } : {}),
        ...(trace.hostCtx.providerId ? { providerId: trace.hostCtx.providerId } : {}),
        ...(trace.hostCtx.providerLabel ? { providerLabel: trace.hostCtx.providerLabel } : {}),
        ...(trace.hostCtx.modelLabel ? { modelLabel: trace.hostCtx.modelLabel } : {}),
        ...(trace.hostCtx.strategy ? { strategy: trace.hostCtx.strategy } : {}),
        ...(trace.hostCtx.strategySource ? { strategySource: trace.hostCtx.strategySource } : {}),
        tokensIn,
        tokensOut,
        cachedInputTokens: nonNegative(usage?.cachedTokens) ?? 0,
        reasoningTokens: tokenEstimate(response?.thinking),
        usageSource: usage ? 'provider' : 'estimate',
        composition,
        messageCount: request.messages?.length ?? 0,
        toolResultMessageCount:
          request.messages?.filter((message) => message.role === 'tool').length ?? 0,
        toolNames: collectRequestToolNames(request),
      });
    });
  }
  rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.requestId.localeCompare(b.requestId));
  return rows;
}

async function prepareProjectContext(input: RemoteExportInput): Promise<RemoteExportProjectContext> {
  const db = await getFirestoreDatabase(input.accessToken, input.projectId);
  if (!db) {
    throw new RemoteExportError(
      'no-firestore',
      `Project ${input.projectId} has no default Firestore database.`,
    );
  }
  // The Storage bucket comes from the project's web config when available;
  // otherwise fall back to the default `<projectId>.appspot.com` bucket.
  let bucketId: string | undefined;
  try {
    bucketId = (await resolveFirebaseConfig(input)).storageBucket;
  } catch {
    // No web app / config — the default bucket still works for uploads.
  }
  bucketId = bucketId ?? `${input.projectId}.appspot.com`;
  const ownerUid = await resolveOwnerUid(input.accessToken);
  return { ownerUid, bucketId, accessToken: input.accessToken };
}

async function resolveFirebaseConfig(input: RemoteExportInput): Promise<FirebaseWebConfig> {
  if (input.firebaseConfig?.apiKey && input.firebaseConfig.appId) {
    return {
      apiKey: input.firebaseConfig.apiKey,
      authDomain: input.firebaseConfig.authDomain,
      projectId: input.firebaseConfig.projectId,
      appId: input.firebaseConfig.appId,
      ...(input.firebaseConfig.storageBucket
        ? { storageBucket: input.firebaseConfig.storageBucket }
        : {}),
      ...(input.firebaseConfig.messagingSenderId
        ? { messagingSenderId: input.firebaseConfig.messagingSenderId }
        : {}),
    };
  }
  const apps = await listWebApps(input.accessToken, input.projectId);
  if (apps.length === 0) {
    throw new RemoteExportError(
      'no-web-app',
      `Project ${input.projectId} has no web app. Add one or fetch a Firebase web config first.`,
    );
  }
  return fetchWebConfig(input.accessToken, input.projectId, apps[0]!.appId);
}

/**
 * Resolve a stable owner id for the export from the caller's Google identity
 * (the token's `sub`), so exports are namespaced by user without a Firebase
 * Auth sign-in. Falls back to a sanitized email, then a shared constant.
 */
async function resolveOwnerUid(accessToken: string): Promise<string> {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const j = (await r.json()) as { sub?: string; email?: string };
      if (j.sub) return j.sub;
      if (j.email) return j.email.replace(/[^a-zA-Z0-9_-]+/g, '_');
    }
  } catch {
    // userinfo unavailable — fall through to the shared owner.
  }
  return 'shared';
}

async function putFirestoreDocument(input: PutFirestoreDocumentInput): Promise<void> {
  const url = firestoreDocumentUrl(input.projectId, input.docPath);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(input.data) }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RemoteExportError(
      'firestore-write-failed',
      `Firestore write failed (${response.status}): ${truncate(body, 400)}`,
    );
  }
}

const FIREBASE_STORAGE_API = 'https://firebasestorage.googleapis.com/v0';

async function uploadStorageObject(input: UploadStorageObjectInput): Promise<UploadedRemoteExportArtifact> {
  const { bucketId, accessToken } = input.context;
  const name = encodeURIComponent(input.artifact.path);
  const base = `${FIREBASE_STORAGE_API}/b/${bucketId}/o`;

  // 1. Upload the bytes. The Firebase Storage REST endpoint is CORS-friendly
  //    and treats a cloud-platform Bearer token as an admin write (rules
  //    bypassed) — verified against a live bucket.
  const up = await fetch(`${base}?name=${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': input.artifact.contentType },
    body: input.artifact.bytes as unknown as BodyInit,
  });
  if (!up.ok) {
    throw new RemoteExportError(
      'storage-upload-failed',
      `upload ${up.status}: ${(await up.text().catch(() => '')).slice(0, 240)}`,
    );
  }
  const meta = (await up.json().catch(() => ({}))) as {
    size?: string | number;
    generation?: string;
    md5Hash?: string;
  };

  // 2. The simple upload doesn't set contentEncoding or custom metadata; apply
  //    them with a metadata PATCH.
  if (input.artifact.contentEncoding || (input.metadata && Object.keys(input.metadata).length > 0)) {
    const patch = await fetch(`${base}/${name}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.artifact.contentEncoding ? { contentEncoding: input.artifact.contentEncoding } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    });
    if (!patch.ok) {
      throw new RemoteExportError(
        'storage-upload-failed',
        `metadata ${patch.status}: ${(await patch.text().catch(() => '')).slice(0, 240)}`,
      );
    }
  }

  return uploadedArtifactFromMetadata(input.artifact, meta);
}

function uploadedArtifactFromMetadata(
  artifact: RemoteExportArtifact,
  metadata: { size?: string | number; generation?: string; md5Hash?: string },
): UploadedRemoteExportArtifact {
  return {
    kind: artifact.kind,
    filename: artifact.filename,
    path: artifact.path,
    contentType: artifact.contentType,
    ...(artifact.contentEncoding ? { contentEncoding: artifact.contentEncoding } : {}),
    size: Number(metadata.size ?? artifact.size),
    sha256: artifact.sha256,
    ...(metadata.generation ? { generation: metadata.generation } : {}),
    ...(metadata.md5Hash ? { md5Hash: metadata.md5Hash } : {}),
  };
}

function localMetaFor({
  identity,
  paths,
  includeFullDetails,
  status,
  uploadedArtifacts,
  exportedAt,
  error,
}: {
  identity: RemoteExportIdentity;
  paths: RemoteExportPaths;
  includeFullDetails: boolean;
  status: SessionRemoteExportMeta['status'];
  uploadedArtifacts: readonly UploadedRemoteExportArtifact[];
  exportedAt: number;
  error?: { code: string; message: string };
}): SessionRemoteExportMeta {
  const storageBytes = uploadedArtifacts.reduce((sum, artifact) => sum + artifact.size, 0);
  return {
    exportId: identity.exportId,
    status,
    projectId: identity.projectId,
    ownerUid: identity.ownerUid,
    bucketId: identity.bucketId,
    firestoreDocPath: paths.firestoreDocPath,
    ...(includeFullDetails ? { storageManifestPath: paths.storageManifestPath } : {}),
    includeFullDetails,
    ...(storageBytes > 0 ? { storageBytes } : {}),
    exportedAt,
    ...(error ? { errorCode: error.code, errorMessage: error.message } : {}),
  };
}

function failure(
  code: string,
  message: string,
  exportId?: string,
  firestoreDocPath?: string,
): RemoteExportResult {
  return {
    ok: false,
    code,
    message,
    ...(exportId ? { exportId } : {}),
    ...(firestoreDocPath ? { firestoreDocPath } : {}),
  };
}

async function gzipText(text: string): Promise<Uint8Array> {
  const ctor = globalThis.CompressionStream;
  if (!ctor) {
    throw new RemoteExportError(
      'compression-unavailable',
      'This browser does not support CompressionStream for gzip exports.',
    );
  }
  const stream = new Blob([text]).stream().pipeThrough(new ctor('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createExportId(now: number): string {
  const random = new Uint8Array(8);
  globalThis.crypto.getRandomValues(random);
  const suffix = [...random].map((b) => b.toString(36).padStart(2, '0')).join('');
  return `${now.toString(36)}_${suffix}`;
}

function firestoreDocumentUrl(projectId: string, docPath: string): string {
  const encoded = docPath.split('/').map(encodeURIComponent).join('/');
  return `${FIRESTORE_API}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encoded}`;
}

function toFirestoreFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    fields[key] = toFirestoreValue(raw);
  }
  return fields;
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.filter((item) => item !== undefined).map((item) => toFirestoreValue(item)),
      },
    };
  }
  if (typeof value === 'object' && value !== null) {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  return { stringValue: String(value) };
}

interface RequestTraceLike {
  requestId?: string;
  turnId?: string;
  iteration?: number;
  ts?: number;
  messages?: Array<{
    role?: string;
    text?: string;
    toolCalls?: unknown;
    resultJson?: string;
  }>;
  tools?: Array<{ name?: string; description?: string; parameters?: unknown }>;
  toolDeclarations?: Array<{ name?: string; description?: string; parameters?: unknown }>;
}

interface ResponseTraceLike {
  text?: string;
  thinking?: string;
  usage?: {
    promptTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
}

function nonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeDocId(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RemoteExportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteExportError';
  }
}
