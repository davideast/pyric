import { constants } from 'node:buffer';

const MiB = 1024 * 1024;

/** Characters left in the export string for documents, users, and object metadata. */
const EXPORT_RESERVE_CHARACTERS = 32 * MiB;

/**
 * Object bytes one state export can carry. The export is a single JSON string,
 * V8 caps a string at `MAX_STRING_LENGTH` characters, and base64 writes every
 * three bytes as four characters.
 */
export const MAX_INLINE_EXPORT_STORAGE_BYTES =
  Math.floor((constants.MAX_STRING_LENGTH - EXPORT_RESERVE_CHARACTERS) / 4) * 3;

const inMiB = (bytes: number): string => (bytes / MiB).toFixed(1);

/** A state export whose Storage objects cannot fit in one JSON document. */
export class StateExportTooLargeError extends Error {
  readonly code = 'state-export-too-large';

  constructor(readonly storageBytes: number) {
    super(
      `Storage objects total ${inMiB(storageBytes)} MiB. A state export carries every object inline as ` +
        `base64 in one JSON document, which holds at most ${inMiB(MAX_INLINE_EXPORT_STORAGE_BYTES)} MiB of ` +
        'object bytes. The host and its data are unaffected; only this export is refused.',
    );
    this.name = 'StateExportTooLargeError';
  }
}
