import { DOC_VALUE_ENCODING } from '../../firestore/internal/value-codec.js';
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
  const paths = new Set<string>();
  for (const [id, record] of records) {
    const isMetadata = id === META_RECORD_ID;
    if (isMetadata) continue;
    const isMalformedBucket = !isPlainObject(record);
    if (isMalformedBucket) {
      throw new FirebaseError('invalid-argument', `State import bucket '${id}' must be an object.`);
    }
    validatePersistenceEncoding(record.encoding);
    const documents = record.docs;
    const isMalformedDocuments = !isPlainObject(documents);
    if (isMalformedDocuments) {
      throw new FirebaseError('invalid-argument', `State import bucket '${id}' requires a document map.`);
    }
    for (const [path, document] of Object.entries(documents)) {
      const duplicatePath = paths.has(path);
      if (duplicatePath) throw new FirebaseError('invalid-argument', `State import contains duplicate document '${path}'.`);
      paths.add(path);
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

/** Unknown codecs cannot be treated as corruption: an older host cannot decode them. */
export function validatePersistenceEncoding(encoding: unknown): void {
  const unsupported = encoding !== undefined && encoding !== DOC_VALUE_ENCODING;
  if (unsupported) throw new FirebaseError('invalid-argument', 'Unsupported Firestore value encoding.');
}
