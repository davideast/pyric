import { FirebaseError } from '../internal/firebase-error.js';
import { isPlainObject } from '../../firestore/plain-object.js';
import { CHUNK_FORMAT_VERSION, checksumDocs, deserializeFromBuckets, META_RECORD_ID, parseBundle } from './chunk-format.js';

/** Decode a replacement before its caller changes the current sandbox. */
export function decodeImportBundle(bundle: string) {
  const records = parseBundle(bundle);
  const isMissingMetadata = !records.has(META_RECORD_ID);
  if (isMissingMetadata) {
    throw new FirebaseError('invalid-argument', 'State import requires sandbox metadata.');
  }
  const metadata = records.get(META_RECORD_ID);
  const isMalformedMetadata = !isPlainObject(metadata);
  if (isMalformedMetadata) {
    throw new FirebaseError('invalid-argument', 'State import metadata must be an object.');
  }
  const hasUnsupportedVersion = metadata.version !== CHUNK_FORMAT_VERSION;
  if (hasUnsupportedVersion) {
    throw new FirebaseError('invalid-argument', `State import requires metadata version ${CHUNK_FORMAT_VERSION}.`);
  }
  const isMalformedServices = !isPlainObject(metadata.services);
  if (isMalformedServices) {
    throw new FirebaseError('invalid-argument', 'State import requires a service state map.');
  }
  for (const [id, record] of records) {
    const isMetadata = id === META_RECORD_ID;
    if (isMetadata) continue;
    const isMalformedBucket = !isPlainObject(record);
    if (isMalformedBucket) {
      throw new FirebaseError('invalid-argument', `State import bucket '${id}' must be an object.`);
    }
    const documents = record.docs;
    const isMalformedDocuments = !isPlainObject(documents);
    if (isMalformedDocuments) {
      throw new FirebaseError('invalid-argument', `State import bucket '${id}' requires a document map.`);
    }
    for (const [path, document] of Object.entries(documents)) {
      const isMalformedDocument = !isPlainObject(document);
      if (isMalformedDocument) {
        throw new FirebaseError('invalid-argument', `State import document '${path}' must be an object.`);
      }
    }
    const hasChecksum = record.checksum !== undefined;
    if (hasChecksum) {
      const hasCorruptDocuments = record.checksum !== checksumDocs(documents);
      if (hasCorruptDocuments) {
        throw new FirebaseError('invalid-argument', `State import bucket '${id}' has an invalid checksum.`);
      }
    }
  }
  return deserializeFromBuckets(records);
}
