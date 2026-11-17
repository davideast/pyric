/**
 * Outcome normalization and run-path scrubbing for modular Firestore SDK probes.
 *
 * Records observed synchronous constraint-construction outcomes and asynchronous
 * query document-id sequences without assuming whether an operation resolves or
 * rejects, and replaces dynamic `pyric_oracle/fs_<runId>/` segments so captured
 * error messages remain deterministic across runs.
 */

export interface FirestoreSyncCallOutcome {
  [key: string]: unknown;
  threw: boolean;
  errorName: string | null;
  isTypeError: boolean;
  code: string | null;
  message: string | null;
}

interface FirestoreIdQuerySuccess {
  [key: string]: unknown;
  threw: false;
  ids: string[];
  code: null;
  errorName: null;
}

interface FirestoreIdQueryFailure {
  [key: string]: unknown;
  threw: true;
  ids: null;
  code: string | null;
  errorName: string | null;
  message: string;
}

export type FirestoreIdQueryOutcome = FirestoreIdQuerySuccess | FirestoreIdQueryFailure;

export function scrubFirestoreOracleRunPath(message: string): string {
  return message.replace(/pyric_oracle\/fs_[a-z0-9_]+\//g, 'pyric_oracle/<runId>/');
}

function extractThrownDetail(err: unknown): {
  errorName: string | null;
  isTypeError: boolean;
  code: string | null;
  message: string;
} {
  const candidate = err as { name?: unknown; code?: unknown; message?: unknown };
  let errorName: string | null = null;
  if (typeof candidate?.name === 'string') {
    errorName = candidate.name;
  }
  let code: string | null = null;
  if (typeof candidate?.code === 'string') {
    code = candidate.code;
  }
  let rawMessage = String(err);
  if (err instanceof Error) {
    rawMessage = err.message;
  }
  return {
    errorName,
    isTypeError: err instanceof TypeError,
    code,
    message: scrubFirestoreOracleRunPath(rawMessage),
  };
}

export function observeFirestoreCall(fn: () => unknown): FirestoreSyncCallOutcome {
  try {
    fn();
    return {
      threw: false,
      errorName: null,
      isTypeError: false,
      code: null,
      message: null,
    };
  } catch (err) {
    const detail = extractThrownDetail(err);
    return {
      threw: true,
      errorName: detail.errorName,
      isTypeError: detail.isTypeError,
      code: detail.code,
      message: detail.message,
    };
  }
}

export async function observeFirestoreIdQuery(
  runQuery: () => Promise<{ docs: ReadonlyArray<{ id: string }> }>,
): Promise<FirestoreIdQueryOutcome> {
  try {
    const snapshot = await runQuery();
    return {
      threw: false,
      ids: snapshot.docs.map((item) => item.id),
      code: null,
      errorName: null,
    };
  } catch (err) {
    const detail = extractThrownDetail(err);
    return {
      threw: true,
      ids: null,
      code: detail.code,
      errorName: detail.errorName,
      message: detail.message,
    };
  }
}
