/**
 * The ceiling on Storage bytes one document carries inline.
 *
 * Some state documents hold every Storage object's bytes as base64 inside one
 * JSON string: the in-process `storage.json`, a browser `--persist` state
 * file, an inline state capture with the checkpoint and branch files written
 * from it. A JavaScript engine caps the length of a string, and base64 writes
 * every three bytes as four characters, so the Storage such a document can
 * hold is bounded. Past the bound, `JSON.stringify` or the base64 encoder
 * throws a `RangeError` that names no limit. Every inline writer checks its
 * total against {@link inlineStorageLimit} before it encodes a byte, and
 * refuses with {@link InlineStorageLimitError}.
 *
 * Pure arithmetic over sizes and base64 lengths, with no host buffer type, so
 * the same values hold in Node, Bun, a browser, and a worker.
 */
import { FirebaseError } from './firebase-error.js';

const MiB = 1024 * 1024;

/** V8's maximum string length on 64-bit platforms, in UTF-16 code units. */
const ENGINE_MAX_STRING_LENGTH = 2 ** 29 - 24;

/** Characters left in the document for paths, metadata, and other services. */
const DOCUMENT_RESERVE_CHARACTERS = 32 * MiB;

/**
 * Object bytes one inline document can carry: the engine's string length,
 * less the reserve, read as base64.
 */
export const MAX_INLINE_STORAGE_BYTES =
  Math.floor((ENGINE_MAX_STRING_LENGTH - DOCUMENT_RESERVE_CHARACTERS) / 4) * 3;

let activeLimit = MAX_INLINE_STORAGE_BYTES;

/** The limit inline writers enforce: {@link MAX_INLINE_STORAGE_BYTES} unless a test lowered it. */
export function inlineStorageLimit(): number {
  return activeLimit;
}

/**
 * Test seam: enforce `bytes` in place of {@link MAX_INLINE_STORAGE_BYTES}, so
 * a test reaches the refusal with a few bytes. Returns the function that
 * restores the previous limit.
 */
export function setInlineStorageLimitForTesting(bytes: number): () => void {
  const isValidLimit = Number.isSafeInteger(bytes) && bytes >= 0;
  if (!isValidLimit) throw new RangeError(`An inline Storage limit is a non-negative integer of bytes; received ${String(bytes)}.`);
  const previous = activeLimit;
  activeLimit = bytes;
  return () => {
    activeLimit = previous;
  };
}

/** The number of bytes a base64 string decodes to, padded or not, without decoding it. */
export function base64DecodedLength(base64: string): number {
  let end = base64.length;
  while (end > 0 && base64.charCodeAt(end - 1) === 0x3d) end -= 1;
  const whole = Math.floor(end / 4) * 3;
  const remainder = end % 4;
  const partial = remainder === 0 ? 0 : remainder - 1;
  return whole + partial;
}

const inMiB = (bytes: number): string => (bytes / MiB).toFixed(1);

/** What to use in place of an inline document that holds a project's Storage. */
export const BY_REFERENCE_ALTERNATIVE =
  'Run the project on the Node host (`pyric sandbox --hosted`), which keeps Storage bytes as files, ' +
  'and save its state with `pyric snapshot`, which writes them by reference.';

/** Where an inline document is written, and what to use in its place past the limit. */
export interface InlineStorageDocument {
  /** The document, for example `The in-process storage file .pyric/state/storage.json`. */
  document: string;
  /** What to do instead, as one or more sentences. */
  instead: string;
}

/** A document whose Storage objects exceed the bytes one inline document can carry. */
export class InlineStorageLimitError extends FirebaseError {
  constructor(
    readonly storageBytes: number,
    readonly limitBytes: number,
    target: InlineStorageDocument,
  ) {
    super(
      'storage/quota-exceeded',
      `Storage objects total ${inMiB(storageBytes)} MiB (${storageBytes} bytes). ${target.document} carries every ` +
        `object inline as base64 in one JSON document, which holds at most ${inMiB(limitBytes)} MiB ` +
        `(${limitBytes} bytes) of object bytes (MAX_INLINE_STORAGE_BYTES). Nothing was written. ${target.instead}`,
      { storageBytes, limitBytes },
    );
  }
}

/** Refuse, before anything is encoded, a total that one inline document cannot carry. */
export function assertInlineStorageFits(storageBytes: number, target: InlineStorageDocument): void {
  const limit = inlineStorageLimit();
  const exceeds = storageBytes > limit;
  if (exceeds) throw new InlineStorageLimitError(storageBytes, limit, target);
}
