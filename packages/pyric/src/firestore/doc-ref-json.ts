import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { validateFirestoreJson, type JsonObjectSchema } from './json-schema.js';
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  FirestoreDataConverter,
} from './types.js';

const DOCUMENT_REFERENCE_JSON_TYPE = 'firestore/documentReference/1.0';

const DOCUMENT_REFERENCE_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: DOCUMENT_REFERENCE_JSON_TYPE },
  referencePath: { typeString: 'string' },
};

type DocumentReferenceBuilder = (
  firestore: Firestore,
  referencePath: string,
  converter?: FirestoreDataConverter<unknown, DocumentData> | null,
) => DocumentReference<unknown>;

let buildDocumentReferenceFromJson: DocumentReferenceBuilder | undefined;

export function registerDocumentReferenceFromJson(builder: DocumentReferenceBuilder): void {
  buildDocumentReferenceFromJson = builder;
}

export function buildDocumentReferenceToJson(path: string): () => {
  type: string;
  referencePath: string;
} {
  return () => ({
    type: DOCUMENT_REFERENCE_JSON_TYPE,
    referencePath: path,
  });
}

export function invokeDocumentReferenceFromJson(
  firestore: Firestore,
  json: object,
  converter?: FirestoreDataConverter<unknown, DocumentData> | null,
): DocumentReference<unknown> {
  if (buildDocumentReferenceFromJson === undefined) {
    throw new FirebaseError(
      'internal',
      'pyric/firestore: DocumentReference.fromJSON resolver not initialized.',
    );
  }
  const validated = validateFirestoreJson(json, DOCUMENT_REFERENCE_JSON_SCHEMA);
  return buildDocumentReferenceFromJson(
    firestore,
    validated.referencePath as string,
    converter,
  );
}
