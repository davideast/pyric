/**
 * Production capture helper for Firestore `where(field, op, value)` probes that
 * trigger Bun `@grpc/grpc-js` `Listen` stream stalls (`not-in`, `!= null`, `in [..., null]`).
 *
 * Under Bun, `@firebase/firestore`'s Node bundle (`@grpc/grpc-js` over `node:http2`)
 * can stall indefinitely without settling `getDocs` on `not-in` or server-rejected
 * null/disjunctive `Listen` targets. To capture genuine production behavior rather
 * than a Bun transport timeout artifact:
 *   1. Runs the `firebase/firestore` query inside a bounded `node` subprocess
 *      (`transport: 'firebase-js-sdk-node'`).
 *   2. If the Node `Listen` stream still does not settle within the bound, executes
 *      the wire-identical `StructuredQuery` against Cloud Firestore's REST `:runQuery`
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
import {
  runFirestoreRestFieldQuery,
  type FirestoreQueryOperand,
  type FirestoreQueryScalar,
  type FirestoreRestFieldQueryOptions,
  type SupportedFieldFilterOp,
} from './firestore-rest-run-query.ts';
import { loadOracleServiceAccount, oracleAccessToken } from './oracle-credential.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_PACKAGE_ROOT = join(HERE, '..');
const FIRESTORE_DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const DEFAULT_NODE_QUERY_TIMEOUT_MS = 12_000;
const DEFAULT_REST_QUERY_TIMEOUT_MS = 15_000;

interface FirestoreNodeFieldQueryParams {
  webConfig: FirebaseOptions;
  collectionPath: string;
  field: string;
  op?: SupportedFieldFilterOp;
  value?: FirestoreQueryOperand;
  values?: readonly FirestoreQueryScalar[];
  timeoutMs: number;
  emulatorHost?: { host: string; port: number };
}

const NODE_FIELD_QUERY_WORKER_SOURCE = `
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
const appName = 'node-fs-q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const app = initializeApp(payload.webConfig, appName);
const db = getFirestore(app);
let auth = null;

if (payload.emulatorHost) {
  connectFirestoreEmulator(db, payload.emulatorHost.host, payload.emulatorHost.port);
} else {
  auth = getAuth(app);
}

const filterOp = payload.op ?? 'not-in';
let filterValue = payload.values;
if ('value' in payload) {
  filterValue = payload.value;
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
    where(payload.field, filterOp, filterValue),
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
  params: FirestoreNodeFieldQueryParams,
): Promise<FirestoreIdQueryOutcome> {
  const hardKillMs = params.timeoutMs + 12_000;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'node',
      ['--input-type=module', '-e', NODE_FIELD_QUERY_WORKER_SOURCE],
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
          reject(new Error(`Node Firestore probe subprocess failed: ${detail}`));
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
    throw new Error('Node Firestore probe subprocess exited 0 without emitting JSON output');
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

export async function runFirestoreRestNotInQuery(
  options: FirestoreRestFieldQueryOptions,
): Promise<FirestoreIdQueryOutcome> {
  return runFirestoreRestFieldQuery(options);
}

interface ObserveFirestoreFieldQueryOptions {
  webConfig: FirebaseOptions;
  collectionPath: string;
  field: string;
  op: SupportedFieldFilterOp;
  value: FirestoreQueryOperand;
  nodeTimeoutMs?: number;
  restTimeoutMs?: number;
  runNodeQuery?: (params: FirestoreNodeFieldQueryParams) => Promise<FirestoreIdQueryOutcome>;
  runRestQuery?: (params: {
    collectionPath: string;
    field: string;
    op: SupportedFieldFilterOp;
    value: FirestoreQueryOperand;
    timeoutMs: number;
  }) => Promise<FirestoreIdQueryOutcome>;
}

export async function observeFirestoreFieldQuery(
  options: ObserveFirestoreFieldQueryOptions,
): Promise<FirestoreIdQueryOutcome> {
  const nodeTimeoutMs = options.nodeTimeoutMs ?? DEFAULT_NODE_QUERY_TIMEOUT_MS;
  const restTimeoutMs = options.restTimeoutMs ?? DEFAULT_REST_QUERY_TIMEOUT_MS;
  const runNode = options.runNodeQuery ?? runNodeFirestoreNotInSubprocess;
  const runRest =
    options.runRestQuery ??
    (async (restParams) => {
      const sa = await loadOracleServiceAccount();
      const accessToken = await oracleAccessToken(sa, FIRESTORE_DATASTORE_SCOPE);
      return runFirestoreRestFieldQuery({
        projectId: sa.project_id,
        accessToken,
        collectionPath: restParams.collectionPath,
        field: restParams.field,
        op: restParams.op,
        value: restParams.value,
        timeoutMs: restParams.timeoutMs,
      });
    });

  let nodeFailureReason = '';
  try {
    return await runNode({
      webConfig: options.webConfig,
      collectionPath: options.collectionPath,
      field: options.field,
      op: options.op,
      value: options.value,
      timeoutMs: nodeTimeoutMs,
    });
  } catch (nodeErr) {
    if (nodeErr instanceof Error) {
      nodeFailureReason = nodeErr.message;
    } else {
      nodeFailureReason = String(nodeErr);
    }
    console.warn(
      `[sdk-probes] Node firebase/firestore did not settle '${options.op}' on '${options.field}' (${nodeFailureReason}); falling back to Firestore REST runQuery.`,
    );
  }

  try {
    return await runRest({
      collectionPath: options.collectionPath,
      field: options.field,
      op: options.op,
      value: options.value,
      timeoutMs: restTimeoutMs,
    });
  } catch (restErr) {
    let restReason = String(restErr);
    if (restErr instanceof Error) {
      restReason = restErr.message;
    }
    throw new Error(
      `Skipped Firestore ${options.op} probe on '${options.field}' (neither Node firebase/firestore [${nodeFailureReason}] nor Firestore REST runQuery [${restReason}] produced a settled production answer).`,
    );
  }
}

interface ObserveFirestoreNotInQueryOptions {
  webConfig: FirebaseOptions;
  collectionPath: string;
  field: string;
  values: readonly FirestoreQueryScalar[];
  nodeTimeoutMs?: number;
  restTimeoutMs?: number;
  runNodeQuery?: (params: FirestoreNodeFieldQueryParams) => Promise<FirestoreIdQueryOutcome>;
  runRestQuery?: (params: {
    collectionPath: string;
    field: string;
    values: readonly FirestoreQueryScalar[];
    timeoutMs: number;
  }) => Promise<FirestoreIdQueryOutcome>;
}

export async function observeFirestoreNotInQuery(
  options: ObserveFirestoreNotInQueryOptions,
): Promise<FirestoreIdQueryOutcome> {
  let adaptedRest: ObserveFirestoreFieldQueryOptions['runRestQuery'];
  if (options.runRestQuery !== undefined) {
    const callerRest = options.runRestQuery;
    adaptedRest = async (restParams) =>
      callerRest({
        collectionPath: restParams.collectionPath,
        field: restParams.field,
        values: options.values,
        timeoutMs: restParams.timeoutMs,
      });
  }
  return observeFirestoreFieldQuery({
    webConfig: options.webConfig,
    collectionPath: options.collectionPath,
    field: options.field,
    op: 'not-in',
    value: options.values,
    nodeTimeoutMs: options.nodeTimeoutMs,
    restTimeoutMs: options.restTimeoutMs,
    runNodeQuery: options.runNodeQuery,
    runRestQuery: adaptedRest,
  });
}
