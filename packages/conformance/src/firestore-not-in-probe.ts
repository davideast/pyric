/**
 * Production capture helper for Firestore `where(field, 'not-in', values)` probes.
 *
 * Under Bun, `@firebase/firestore`'s Node bundle (`@grpc/grpc-js` over `node:http2`)
 * hangs indefinitely without settling `getDocs` on `not-in` queries. To capture
 * genuine production behavior rather than a Bun transport timeout artifact:
 *   1. Runs the `firebase/firestore` query inside a bounded `node` subprocess
 *      (`transport: 'firebase-js-sdk-node'`).
 *   2. If the Node `Listen` stream still does not settle within the bound, executes
 *      the identical `StructuredQuery` against Cloud Firestore's REST `:runQuery`
 *      endpoint using the oracle credential (`transport: 'firestore-rest-runQuery'`).
 *   3. Fails closed (throws without writing an observation) if neither transport
 *      produces a settled Firestore query outcome.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FirebaseOptions } from 'firebase/app';
import {
  FirestoreQueryTimeoutError,
  scrubFirestoreOracleRunPath,
  type FirestoreIdQueryOutcome,
} from './firestore-probe-outcomes.ts';
import { loadOracleServiceAccount, oracleAccessToken } from './oracle-credential.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_PACKAGE_ROOT = join(HERE, '..');
const FIRESTORE_REST_API = 'https://firestore.googleapis.com/v1';
const FIRESTORE_DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const DEFAULT_NODE_NOT_IN_TIMEOUT_MS = 12_000;
const DEFAULT_REST_NOT_IN_TIMEOUT_MS = 15_000;

type FirestoreNotInScalar = number | string | boolean | null;

interface FirestoreNotInQueryParams {
  webConfig: FirebaseOptions;
  collectionPath: string;
  field: string;
  values: readonly FirestoreNotInScalar[];
  timeoutMs: number;
  emulatorHost?: { host: string; port: number };
}

interface RestQueryFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

type RestQueryFetch = (url: string, init: RestQueryFetchInit) => Promise<Response>;

interface FirestoreRestNotInOptions {
  projectId: string;
  accessToken: string;
  collectionPath: string;
  field: string;
  values: readonly FirestoreNotInScalar[];
  timeoutMs?: number;
  fetchImpl?: RestQueryFetch;
}

const NODE_NOT_IN_WORKER_SOURCE = `
import { deleteApp, initializeApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  getDocs,
  getFirestore,
  query,
  terminate,
  where,
} from 'firebase/firestore';

const rawPayload = process.env.PYRIC_NODE_NOT_IN_PAYLOAD ?? '{}';
const payload = JSON.parse(rawPayload);
const appName = 'node-not-in-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const app = initializeApp(payload.webConfig, appName);
const db = getFirestore(app);
let auth = null;

if (payload.emulatorHost) {
  connectFirestoreEmulator(db, payload.emulatorHost.host, payload.emulatorHost.port);
} else {
  auth = getAuth(app);
}

let timer = undefined;
const timeoutSentinel = Symbol('timeout');

try {
  if (auth !== null) {
    await Promise.race([
      signInAnonymously(auth),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutSentinel), payload.timeoutMs);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (auth.currentUser === null) {
      process.stdout.write(JSON.stringify({ status: 'timeout', stage: 'auth' }) + '\\n');
      process.exit(0);
    }
  }

  const target = query(
    collection(db, payload.collectionPath),
    where(payload.field, 'not-in', payload.values),
  );
  const raced = await Promise.race([
    getDocs(target).then(
      (snap) => ({
        kind: 'resolved',
        ids: snap.docs.map((docSnap) => docSnap.id),
      }),
      (err) => ({
        kind: 'rejected',
        err,
      }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), payload.timeoutMs);
    }),
  ]);

  if (raced.kind === 'timeout') {
    process.stdout.write(JSON.stringify({ status: 'timeout', stage: 'query' }) + '\\n');
  } else if (raced.kind === 'resolved') {
    process.stdout.write(
      JSON.stringify({
        status: 'settled',
        outcome: {
          threw: false,
          ids: raced.ids,
          code: null,
          errorName: null,
        },
      }) + '\\n',
    );
  } else {
    const errObj = raced.err || {};
    let errorName = null;
    if (typeof errObj.name === 'string') {
      errorName = errObj.name;
    }
    let code = null;
    if (typeof errObj.code === 'string') {
      code = errObj.code;
    }
    let message = String(raced.err);
    if (raced.err instanceof Error) {
      message = raced.err.message;
    }
    process.stdout.write(
      JSON.stringify({
        status: 'settled',
        outcome: {
          threw: true,
          ids: null,
          code,
          errorName,
          message,
        },
      }) + '\\n',
    );
  }
} finally {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (auth !== null && auth.currentUser !== null) {
    await deleteUser(auth.currentUser).catch(() => undefined);
  }
  await terminate(db).catch(() => undefined);
  await deleteApp(app).catch(() => undefined);
}
process.exit(0);
`;

export async function runNodeFirestoreNotInSubprocess(
  params: FirestoreNotInQueryParams,
): Promise<FirestoreIdQueryOutcome> {
  const hardKillMs = params.timeoutMs + 4_000;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'node',
      ['--input-type=module', '-e', NODE_NOT_IN_WORKER_SOURCE],
      {
        cwd: CONFORMANCE_PACKAGE_ROOT,
        env: {
          ...process.env,
          PYRIC_NODE_NOT_IN_PAYLOAD: JSON.stringify(params),
        },
        timeout: hardKillMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, out, stderr) => {
        if (err) {
          const killedByTimeout = Boolean((err as { killed?: boolean }).killed);
          if (killedByTimeout) {
            reject(new FirestoreQueryTimeoutError(params.timeoutMs, 'node subprocess hard-timeout'));
            return;
          }
          let detail = err.message;
          if (stderr && stderr.trim().length > 0) {
            detail = `${err.message}: ${stderr.trim()}`;
          }
          reject(new Error(`Node not-in subprocess failed: ${detail}`));
          return;
        }
        resolve(out);
      },
    );
  });

  const lastLine = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .pop();
  if (!lastLine) {
    throw new Error('Node not-in subprocess exited 0 without emitting JSON output');
  }
  const parsed = JSON.parse(lastLine) as
    | { status: 'timeout'; stage?: string }
    | { status: 'settled'; outcome: FirestoreIdQueryOutcome };
  if (parsed.status === 'timeout') {
    const stage = parsed.stage ?? 'query';
    throw new FirestoreQueryTimeoutError(params.timeoutMs, `node firebase/firestore (${stage})`);
  }
  if (parsed.outcome.threw) {
    return {
      threw: true,
      ids: null,
      code: parsed.outcome.code,
      errorName: parsed.outcome.errorName,
      message: scrubFirestoreOracleRunPath(parsed.outcome.message),
      transport: 'firebase-js-sdk-node',
    };
  }
  return {
    threw: false,
    ids: parsed.outcome.ids,
    code: null,
    errorName: null,
    transport: 'firebase-js-sdk-node',
  };
}

function encodeFirestoreRestScalar(value: FirestoreNotInScalar): Record<string, unknown> {
  if (value === null) {
    return { nullValue: 'NULL_VALUE' };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Number.isInteger(value) && !Object.is(value, -0)) {
    return { integerValue: String(value) };
  }
  return { doubleValue: value };
}

function splitCollectionParentAndId(collectionPath: string): {
  parentDocPath: string;
  collectionId: string;
} {
  const segments = collectionPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length % 2 === 0) {
    throw new Error(`Expected odd-segment Firestore collection path, got '${collectionPath}'`);
  }
  const collectionId = segments[segments.length - 1] ?? '';
  const parentDocPath = segments.slice(0, -1).join('/');
  return { parentDocPath, collectionId };
}

function mapGrpcStatusToFirestoreCode(status: string | undefined): string | null {
  if (!status || status.trim().length === 0) {
    return null;
  }
  return status.trim().toLowerCase().replace(/_/g, '-');
}

export async function runFirestoreRestNotInQuery(
  options: FirestoreRestNotInOptions,
): Promise<FirestoreIdQueryOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REST_NOT_IN_TIMEOUT_MS;
  const fetchImpl: RestQueryFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const { parentDocPath, collectionId } = splitCollectionParentAndId(options.collectionPath);

  let parentSegment = '';
  if (parentDocPath.length > 0) {
    parentSegment = `/${parentDocPath}`;
  }
  const url = `${FIRESTORE_REST_API}/projects/${encodeURIComponent(options.projectId)}/databases/(default)/documents${parentSegment}:runQuery`;

  const structuredQuery = {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath: options.field },
        op: 'NOT_IN',
        value: {
          arrayValue: {
            values: options.values.map((entry) => encodeFirestoreRestScalar(entry)),
          },
        },
      },
    },
    orderBy: [
      { field: { fieldPath: options.field }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ],
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new FirestoreQueryTimeoutError(timeoutMs, 'Firestore REST runQuery');
    }
    throw err;
  }

  const rawText = await response.text();
  if (response.status === 200) {
    const entries = JSON.parse(rawText) as Array<{ document?: { name?: unknown } }>;
    const ids: string[] = [];
    for (const entry of entries) {
      const docName = entry.document?.name;
      if (typeof docName === 'string') {
        const lastSlash = docName.lastIndexOf('/');
        const id = docName.slice(lastSlash + 1);
        if (id.length > 0) {
          ids.push(id);
        }
      }
    }
    return {
      threw: false,
      ids,
      code: null,
      errorName: null,
      transport: 'firestore-rest-runQuery',
    };
  }

  // Only HTTP 400 (INVALID_ARGUMENT / FAILED_PRECONDITION) represents a Firestore
  // query-semantics rejection; auth/IAM/quota/5xx failures must fail closed so
  // infrastructure issues are never recorded as query behavior.
  if (response.status === 400) {
    const parsed = JSON.parse(rawText) as
      | { error?: { status?: string; message?: string } }
      | Array<{ error?: { status?: string; message?: string } }>;
    let errEnvelope: { status?: string; message?: string } | undefined;
    if (Array.isArray(parsed)) {
      errEnvelope = parsed[0]?.error;
    } else {
      errEnvelope = parsed.error;
    }
    const mappedCode = mapGrpcStatusToFirestoreCode(errEnvelope?.status);
    let code = 'invalid-argument';
    if (mappedCode !== null) {
      code = mappedCode;
    }
    let rawMessage = rawText;
    if (typeof errEnvelope?.message === 'string' && errEnvelope.message.length > 0) {
      rawMessage = errEnvelope.message;
    }
    const message = scrubFirestoreOracleRunPath(rawMessage);
    return {
      threw: true,
      ids: null,
      code,
      errorName: 'FirebaseError',
      message,
      transport: 'firestore-rest-runQuery',
    };
  }

  throw new Error(
    `Firestore REST runQuery failed with HTTP ${response.status} (refusing to record non-query error as observation): ${rawText.slice(0, 300)}`,
  );
}

interface ObserveFirestoreNotInQueryOptions {
  webConfig: FirebaseOptions;
  collectionPath: string;
  field: string;
  values: readonly FirestoreNotInScalar[];
  nodeTimeoutMs?: number;
  restTimeoutMs?: number;
  runNodeQuery?: (params: FirestoreNotInQueryParams) => Promise<FirestoreIdQueryOutcome>;
  runRestQuery?: (params: {
    collectionPath: string;
    field: string;
    values: readonly FirestoreNotInScalar[];
    timeoutMs: number;
  }) => Promise<FirestoreIdQueryOutcome>;
}

export async function observeFirestoreNotInQuery(
  options: ObserveFirestoreNotInQueryOptions,
): Promise<FirestoreIdQueryOutcome> {
  const nodeTimeoutMs = options.nodeTimeoutMs ?? DEFAULT_NODE_NOT_IN_TIMEOUT_MS;
  const restTimeoutMs = options.restTimeoutMs ?? DEFAULT_REST_NOT_IN_TIMEOUT_MS;
  const runNode = options.runNodeQuery ?? runNodeFirestoreNotInSubprocess;
  const runRest =
    options.runRestQuery ??
    (async (restParams) => {
      const sa = await loadOracleServiceAccount();
      const accessToken = await oracleAccessToken(sa, FIRESTORE_DATASTORE_SCOPE);
      return runFirestoreRestNotInQuery({
        projectId: sa.project_id,
        accessToken,
        collectionPath: restParams.collectionPath,
        field: restParams.field,
        values: restParams.values,
        timeoutMs: restParams.timeoutMs,
      });
    });

  let nodeFailureReason = '';
  try {
    return await runNode({
      webConfig: options.webConfig,
      collectionPath: options.collectionPath,
      field: options.field,
      values: options.values,
      timeoutMs: nodeTimeoutMs,
    });
  } catch (nodeErr) {
    if (nodeErr instanceof Error) {
      nodeFailureReason = nodeErr.message;
    } else {
      nodeFailureReason = String(nodeErr);
    }
    console.warn(
      `[sdk-probes] Node firebase/firestore did not settle not-in on '${options.field}' (${nodeFailureReason}); falling back to Firestore REST runQuery.`,
    );
  }

  try {
    return await runRest({
      collectionPath: options.collectionPath,
      field: options.field,
      values: options.values,
      timeoutMs: restTimeoutMs,
    });
  } catch (restErr) {
    let restReason = String(restErr);
    if (restErr instanceof Error) {
      restReason = restErr.message;
    }
    throw new Error(
      `Skipped Firestore not-in probe on '${options.field}' (neither Node firebase/firestore [${nodeFailureReason}] nor Firestore REST runQuery [${restReason}] produced a settled production answer).`,
    );
  }
}
