/**
 * Field values, spelled as JSON.
 *
 * A Firestore field value is a function call: `serverTimestamp()`,
 * `increment(2)`, `arrayUnion('a')`. A tool call is JSON, and JSON has no
 * function calls, so an agent writing through `setDoc`, `updateDoc`, `addDoc`,
 * or `writeBatch` could write any value except the five that matter most. It
 * could pin the clock and then have to guess the instant to write by hand,
 * which is exactly the seam the clock exists to remove.
 *
 * So each field value has one JSON spelling, and this module is the only place
 * that knows it:
 *
 * - `{"$serverTimestamp": true}`
 * - `{"$increment": 2}`
 * - `{"$arrayUnion": ["a", "b"]}`
 * - `{"$arrayRemove": ["a"]}`
 * - `{"$deleteField": true}`
 *
 * An object whose keys include one beginning with `$` is a spelling attempt,
 * and it is decoded or refused. It is never written through as data: a
 * misspelled sentinel that landed as a literal `{"$incrementt": 1}` in a
 * document would be a silent wrong answer, and the agent would read the
 * document back and see its own typo stored rather than a refusal it can act
 * on.
 *
 * `$deleteField` is the one with a placement rule, because the SDK has one:
 * `deleteField()` removes a key from a document that already exists, so it
 * belongs to `updateDoc` and to a `writeBatch` update, and nowhere else.
 */
import {
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from 'pyric/firestore';

/** What a caller gets back: the decoded value, or the reason it was refused. */
export type FieldValueDecoding =
  | { ok: true; value: unknown }
  | { ok: false; path: string; body: string; fix: string };

/** Every spelling, and the form each one accepts, in one sentence. */
export const ACCEPTED_FIELD_VALUES =
  `{"$serverTimestamp": true}, {"$increment": <number>}, {"$arrayUnion": [...]}, ` +
  `{"$arrayRemove": [...]}, {"$deleteField": true}`;

/** The spellings, so a refusal can name the one the caller nearly wrote. */
const SPELLINGS = [
  '$serverTimestamp',
  '$increment',
  '$arrayUnion',
  '$arrayRemove',
  '$deleteField',
] as const;

/** The form one spelling accepts, for the refusal that names it. */
const FORM: Readonly<Record<string, string>> = {
  $serverTimestamp: '{"$serverTimestamp": true}',
  $increment: '{"$increment": <number>}',
  $arrayUnion: '{"$arrayUnion": [<value>, ...]}',
  $arrayRemove: '{"$arrayRemove": [<value>, ...]}',
  $deleteField: '{"$deleteField": true}',
};

/** Where `$deleteField` is accepted, phrased for the refusal that names it. */
const DELETE_FIELD_PLACEMENT =
  '$deleteField removes a key from a document that already exists, so it is accepted by ' +
  'updateDoc and by a writeBatch entry of type update.';

/** A plain object, as opposed to an array or a null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How this value reads back in a refusal. */
function shown(value: unknown): string {
  if (value === undefined) return 'nothing';
  return JSON.stringify(value) ?? String(value);
}

/** Is this object an attempt at one of the spellings? */
function isSpellingAttempt(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => key.startsWith('$'));
}

/** Refuse one spelling attempt, naming the path, the spelling, and the form. */
function refuse(path: string, body: string, fix: string): FieldValueDecoding {
  return { ok: false, path, body, fix };
}

/**
 * Decode one spelling attempt: an object carrying at least one `$` key. It
 * either becomes a field value or is refused; nothing else can happen to it.
 */
function decodeSpelling(
  path: string,
  attempt: Record<string, unknown>,
  deleteFieldAccepted: boolean,
  method: string,
): FieldValueDecoding {
  const keys = Object.keys(attempt);
  if (keys.length > 1) {
    return refuse(
      path,
      `${path} names ${shown(attempt)}. A field value is an object with exactly one key, and this one has ${keys.length}.`,
      `Write ${path} as one of ${ACCEPTED_FIELD_VALUES}, or drop the $ from a key that was meant to be a plain field name.`,
    );
  }
  const spelling = keys[0]!;
  if (!SPELLINGS.includes(spelling as (typeof SPELLINGS)[number])) {
    return refuse(
      path,
      `${path} names ${spelling}, which is not a field value.`,
      `Write ${path} as one of ${ACCEPTED_FIELD_VALUES}, or drop the $ from a key that was meant to be a plain field name.`,
    );
  }
  const named = attempt[spelling];

  if (spelling === '$serverTimestamp') {
    if (named !== true) {
      return refuse(path, `${path} holds $serverTimestamp with ${shown(named)}.`, `Write ${path} as ${FORM.$serverTimestamp}.`);
    }
    return { ok: true, value: serverTimestamp() };
  }

  if (spelling === '$increment') {
    if (typeof named !== 'number' || !Number.isFinite(named)) {
      return refuse(path, `${path} holds $increment with ${shown(named)}.`, `Write ${path} as ${FORM.$increment}.`);
    }
    return { ok: true, value: increment(named) };
  }

  if (spelling === '$arrayUnion' || spelling === '$arrayRemove') {
    if (!Array.isArray(named)) {
      return refuse(path, `${path} holds ${spelling} with ${shown(named)}.`, `Write ${path} as ${FORM[spelling]}.`);
    }
    if (spelling === '$arrayUnion') return { ok: true, value: arrayUnion(...named) };
    return { ok: true, value: arrayRemove(...named) };
  }

  if (named !== true) {
    return refuse(path, `${path} holds $deleteField with ${shown(named)}.`, `Write ${path} as ${FORM.$deleteField}.`);
  }
  if (!deleteFieldAccepted) {
    return refuse(
      path,
      `${path} holds $deleteField, which ${method} does not accept. ${DELETE_FIELD_PLACEMENT}`,
      `Call updateDoc to remove ${path}, or drop it from this ${method} call.`,
    );
  }
  return { ok: true, value: deleteField() };
}

/** What the walk needs to know about the call it is decoding for. */
export interface FieldValueScope {
  /** The method named in a refusal, so the caller reads its own call back. */
  method: string;
  /** Whether `$deleteField` is accepted here. */
  deleteFieldAccepted: boolean;
  /** The path a refusal counts from, such as `data` or `writes.0.data`. */
  root: string;
}

/**
 * Walk `data`, replacing every field-value spelling with the SDK's own value.
 * Returns the rewritten data, or the first refusal, which names the field path
 * so a caller can correct exactly one field rather than re-reading the object.
 */
export function decodeFieldValues(data: unknown, scope: FieldValueScope): FieldValueDecoding {
  return walk(data, scope.root, scope);
}

function walk(value: unknown, path: string, scope: FieldValueScope): FieldValueDecoding {
  if (Array.isArray(value)) {
    const decoded: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      const one = walk(entry, `${path}[${index}]`, scope);
      if (!one.ok) return one;
      decoded.push(one.value);
    }
    return { ok: true, value: decoded };
  }
  if (!isPlainObject(value)) return { ok: true, value };
  if (isSpellingAttempt(value)) {
    return decodeSpelling(path, value, scope.deleteFieldAccepted, scope.method);
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const one = walk(entry, `${path}.${key}`, scope);
    if (!one.ok) return one;
    decoded[key] = one.value;
  }
  return { ok: true, value: decoded };
}
