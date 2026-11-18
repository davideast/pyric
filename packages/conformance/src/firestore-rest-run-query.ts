/**
 * Cloud Firestore v1 REST `:runQuery` fallback for modular SDK probes.
 *
 * Encodes single-field `where(field, op, value)` constraints into the exact
 * `StructuredQuery` JSON emitted by `@firebase/firestore/lite` (`IS_NULL` /
 * `IS_NOT_NULL` unary filters for `null` equality/inequality, `NULL_VALUE` enum
 * array items for `in`/`not-in`, and implicit `ASCENDING` field + `__name__`
 * ordering) and maps HTTP 200 document streams and HTTP 400 query rejections
 * while failing closed on infrastructure/IAM statuses.
 */
import {
  FirestoreQueryTimeoutError,
  scrubFirestoreOracleRunPath,
  type FirestoreIdQueryOutcome,
} from './firestore-probe-outcomes.ts';

const FIRESTORE_REST_API = 'https://firestore.googleapis.com/v1';
const DEFAULT_REST_QUERY_TIMEOUT_MS = 15_000;

export type FirestoreQueryScalar = number | string | boolean | null;
export type SupportedFieldFilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in';
export type FirestoreQueryOperand = FirestoreQueryScalar | readonly FirestoreQueryScalar[];

interface RestQueryFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

type RestQueryFetch = (url: string, init: RestQueryFetchInit) => Promise<Response>;

export interface FirestoreRestFieldQueryOptions {
  projectId: string;
  accessToken: string;
  collectionPath: string;
  field: string;
  op?: SupportedFieldFilterOp;
  value?: FirestoreQueryOperand;
  values?: readonly FirestoreQueryScalar[];
  timeoutMs?: number;
  fetchImpl?: RestQueryFetch;
}

function encodeFirestoreRestScalar(value: FirestoreQueryScalar): Record<string, unknown> {
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

const REST_SCALAR_OP_BY_SDK_OP: Readonly<Record<string, string>> = {
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
};

function buildRestStructuredQuery(
  collectionId: string,
  field: string,
  op: SupportedFieldFilterOp,
  operand: FirestoreQueryOperand,
): Record<string, unknown> {
  const nameAsc = { field: { fieldPath: '__name__' }, direction: 'ASCENDING' };
  const fieldAndNameAsc = [
    { field: { fieldPath: field }, direction: 'ASCENDING' },
    nameAsc,
  ];

  if ((op === '==' || op === '!=') && operand === null) {
    let unaryOp = 'IS_NULL';
    let orderBy = [nameAsc];
    if (op === '!=') {
      unaryOp = 'IS_NOT_NULL';
      orderBy = fieldAndNameAsc;
    }
    return {
      from: [{ collectionId }],
      where: {
        unaryFilter: {
          field: { fieldPath: field },
          op: unaryOp,
        },
      },
      orderBy,
    };
  }

  if (op === 'in' || op === 'not-in') {
    if (!Array.isArray(operand)) {
      throw new Error(`Expected array operand for '${op}' REST StructuredQuery`);
    }
    let restDisjunctiveOp = 'IN';
    let orderBy = [nameAsc];
    if (op === 'not-in') {
      restDisjunctiveOp = 'NOT_IN';
      orderBy = fieldAndNameAsc;
    }
    const items = operand as readonly FirestoreQueryScalar[];
    return {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: restDisjunctiveOp,
          value: {
            arrayValue: {
              values: items.map((entry) => encodeFirestoreRestScalar(entry)),
            },
          },
        },
      },
      orderBy,
    };
  }

  if (Array.isArray(operand)) {
    throw new Error(`Expected scalar operand for '${op}' REST StructuredQuery`);
  }
  const restScalarOp = REST_SCALAR_OP_BY_SDK_OP[op];
  if (!restScalarOp) {
    throw new Error(`Unsupported Firestore filter operator '${op}'`);
  }
  let orderBy = fieldAndNameAsc;
  if (op === '==') {
    orderBy = [nameAsc];
  }
  return {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath: field },
        op: restScalarOp,
        value: encodeFirestoreRestScalar(operand as FirestoreQueryScalar),
      },
    },
    orderBy,
  };
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

export async function runFirestoreRestFieldQuery(
  options: FirestoreRestFieldQueryOptions,
): Promise<FirestoreIdQueryOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REST_QUERY_TIMEOUT_MS;
  const fetchImpl: RestQueryFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const { parentDocPath, collectionId } = splitCollectionParentAndId(options.collectionPath);
  const op = options.op ?? 'not-in';
  let operand: FirestoreQueryOperand | undefined = options.values;
  if ('value' in options) {
    operand = options.value;
  }
  if (operand === undefined) {
    throw new Error('Expected value or values for Firestore REST StructuredQuery');
  }

  let parentSegment = '';
  if (parentDocPath.length > 0) {
    parentSegment = `/${parentDocPath}`;
  }
  const url = `${FIRESTORE_REST_API}/projects/${encodeURIComponent(options.projectId)}/databases/(default)/documents${parentSegment}:runQuery`;
  const structuredQuery = buildRestStructuredQuery(collectionId, options.field, op, operand);

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
