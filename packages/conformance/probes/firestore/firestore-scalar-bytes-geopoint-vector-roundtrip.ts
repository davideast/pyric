import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Bytes, GeoPoint, VectorValue (via vector()), FieldPath, and documentId() expose value equality and serialization helpers and round-trip cleanly through setDoc and getDoc.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        Bytes,
        FieldPath,
        GeoPoint,
        VectorValue,
        collection,
        doc,
        documentId,
        getDoc,
        setDoc,
        vector,
      } = firestoreSdk;

      const bytesInput = Bytes.fromUint8Array(new Uint8Array([0, 127, 255]));
      const bytesFromBase64 = Bytes.fromBase64String(bytesInput.toBase64());
      const geoInput = new GeoPoint(37.7749, -122.4194);
      const vecInput = vector([1.5, -2, 3.25]);
      const fpAB = new FieldPath('a', 'b');
      const fpSame = new FieldPath('a', 'b');
      const fpLiteral = new FieldPath('a.b');
      const docIdPath = documentId();

      const items = collection(db, collectionPath('scalars-roundtrip'));
      const targetRef = doc(items, 'scalar-doc');
      await setDoc(targetRef, {
        payload: bytesInput,
        location: geoInput,
        embedding: vecInput,
      });

      const snap = await getDoc(targetRef);
      const data = snap.data() ?? {};
      const readBytes = data.payload as typeof bytesInput;
      const readGeo = data.location as typeof geoInput;
      const readVec = data.embedding as typeof vecInput;

      return {
        bytes: {
          isBytes: readBytes instanceof Bytes,
          base64: readBytes.toBase64(),
          uint8Array: Array.from(readBytes.toUint8Array()),
          equalsOriginal: readBytes.isEqual(bytesInput),
          equalsFromBase64: readBytes.isEqual(bytesFromBase64),
        },
        geoPoint: {
          isGeoPoint: readGeo instanceof GeoPoint,
          latitude: readGeo.latitude,
          longitude: readGeo.longitude,
          equalsOriginal: readGeo.isEqual(geoInput),
          json: readGeo.toJSON(),
        },
        vector: {
          isVectorValue: readVec instanceof VectorValue,
          array: readVec.toArray(),
          equalsOriginal: readVec.isEqual(vecInput),
          json: readVec.toJSON(),
        },
        fieldPath: {
          isFieldPath: fpAB instanceof FieldPath,
          equalsSameSegments: fpAB.isEqual(fpSame),
          equalsLiteralDot: fpAB.isEqual(fpLiteral),
          documentIdIsFieldPath: docIdPath instanceof FieldPath,
          documentIdEqualsSecondCall: docIdPath.isEqual(documentId()),
        },
      };
    });
  },
};
