import { scrubFirestoreOracleRunPath } from './firestore-probe-outcomes.ts';

interface AsyncWriteOutcome {
  [key: string]: unknown;
  threw: boolean;
  errorName: string | null;
  isFirebaseError: boolean;
  code: string | null;
  messageScrubbed: string | null;
}

export async function observeFirestoreWriteAttempt(
  attempt: () => Promise<unknown>,
  firebaseErrorCtor: abstract new (...args: never[]) => Error,
): Promise<AsyncWriteOutcome> {
  try {
    await attempt();
    return {
      threw: false,
      errorName: null,
      isFirebaseError: false,
      code: null,
      messageScrubbed: null,
    };
  } catch (err) {
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
      threw: true,
      errorName,
      isFirebaseError: err instanceof firebaseErrorCtor,
      code,
      messageScrubbed: scrubFirestoreOracleRunPath(rawMessage),
    };
  }
}

interface SetDocConverterCallSummary {
  argCount: number;
  hasOptions: boolean;
  merge: boolean | null;
  mergeFields: string[] | null;
}

interface SetDocModelItem {
  label?: string;
  units?: number;
  note?: string;
}

function formatMergeFieldEntry(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry !== null && typeof entry === 'object') {
    const internal = (entry as { _internalPath?: { segments?: unknown } })._internalPath;
    if (Array.isArray(internal?.segments)) {
      return internal.segments.map((seg) => String(seg)).join('.');
    }
  }
  return String(entry);
}

export function createSetDocOptionsRecorder() {
  const calls: SetDocConverterCallSummary[] = [];

  const converter = {
    toFirestore(model: SetDocModelItem, options?: { merge?: boolean; mergeFields?: unknown[] }) {
      let mergeVal: boolean | null = null;
      if (typeof options?.merge === 'boolean') {
        mergeVal = options.merge;
      }
      let mergeFieldsVal: string[] | null = null;
      if (Array.isArray(options?.mergeFields)) {
        mergeFieldsVal = options.mergeFields.map((entry) => formatMergeFieldEntry(entry));
      }
      calls.push({
        argCount: arguments.length,
        hasOptions: options !== undefined,
        merge: mergeVal,
        mergeFields: mergeFieldsVal,
      });
      const stored: Record<string, unknown> = { converted: true };
      if (model.label !== undefined) {
        stored.dbLabel = model.label;
      }
      if (model.units !== undefined) {
        stored.dbUnits = model.units * 5;
      }
      if (model.note !== undefined) {
        stored.dbNote = model.note;
      }
      return stored;
    },
    fromFirestore(snapshot: { data: (opts?: unknown) => Record<string, unknown> }, options?: unknown) {
      const data = snapshot.data(options);
      const out: SetDocModelItem = {};
      if (typeof data.dbLabel === 'string') {
        out.label = data.dbLabel;
      }
      if (typeof data.dbUnits === 'number') {
        out.units = data.dbUnits / 5;
      }
      if (typeof data.dbNote === 'string') {
        out.note = data.dbNote;
      }
      return out;
    },
  };

  return { converter, calls };
}
