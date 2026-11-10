import {
  endAt as endAtRtdb,
  endBefore as endBeforeRtdb,
  equalTo as equalToRtdb,
  get as getRtdb,
  limitToFirst as limitToFirstRtdb,
  limitToLast as limitToLastRtdb,
  orderByChild as orderByChildRtdb,
  orderByKey as orderByKeyRtdb,
  orderByValue as orderByValueRtdb,
  query as queryRtdb,
  ref as rtdbRef,
  remove as removeRtdb,
  set as setRtdb,
  startAfter as startAfterRtdb,
  startAt as startAtRtdb,
  update as updateRtdb,
  type Database,
  type QueryConstraint as RtdbQueryConstraint,
} from "pyric/database";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type Query,
  type QueryConstraint,
} from "pyric/firestore";
import { getInternalEnv } from "pyric/sandbox/internal";
import {
  deleteObject,
  getBlob,
  getMetadata,
  listAll,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
} from "pyric/storage";
import {
  decodeBase64,
  decodeFirestoreMapForEnv,
  decodeFirestoreMapForSdk,
  decodeFirestoreValueForSdk,
  normalizeFirestorePath,
  projectStorageObject,
  type ServiceRuntime,
} from "./runner-runtime.js";
import type { FirebaseOperation, StorageOperation } from "./types.js";

type RtdbCursorPrimitive = number | string | boolean | null;

function toRtdbCursorValue(value: unknown): RtdbCursorPrimitive {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error("RTDB query cursor value must be a primitive or null.");
}

export async function executeFirestore(
  operation: FirebaseOperation,
  db: Firestore,
  runtime: ServiceRuntime,
): Promise<unknown> {
  if (operation.service !== "firestore") {
    throw new Error("Expected a Firestore operation.");
  }
  const path = normalizeFirestorePath(operation.path);
  const refDecoder = {
    create: (refPath: string) => doc(db, normalizeFirestorePath(refPath)),
  };
  switch (operation.method) {
    case "get": {
      const snapshot = await getDoc(doc(db, path));
      let exists = Boolean(snapshot.exists);
      if (typeof snapshot.exists === "function") {
        exists = snapshot.exists();
      }
      if (!exists) return null;
      return snapshot.data();
    }
    case "list": {
      const constraints: QueryConstraint[] = [];
      for (const item of operation.query?.where ?? []) {
        constraints.push(
          where(
            item.field,
            item.op,
            decodeFirestoreValueForSdk(item.value, refDecoder),
          ),
        );
      }
      for (const item of operation.query?.orderBy ?? []) {
        constraints.push(orderBy(item.field, item.direction));
      }
      if (operation.query?.limit !== undefined) {
        constraints.push(limit(operation.query.limit));
      }
      let source: Query = collection(db, path);
      if (constraints.length > 0) {
        source = query(collection(db, path), ...constraints);
      }
      const snapshot = await getDocs(source);
      return snapshot.docs.map((item) => ({
        path: `${path}/${item.id}`,
        data: item.data(),
      }));
    }
    case "create": {
      doc(db, path);
      const result = getInternalEnv(runtime.sandbox).execute({
        method: "create",
        path,
        data: decodeFirestoreMapForEnv(operation.data ?? {}),
        auth: runtime.actor.auth,
      });
      if (!result.allowed) {
        throw (
          result.error ??
          new Error(result.debugMessages.join("; ") || "create denied")
        );
      }
      return null;
    }
    case "set":
      await setDoc(
        doc(db, path),
        decodeFirestoreMapForSdk(operation.data ?? {}, refDecoder),
      );
      return null;
    case "merge":
      await setDoc(
        doc(db, path),
        decodeFirestoreMapForSdk(operation.data ?? {}, refDecoder),
        { merge: true },
      );
      return null;
    case "update":
      await updateDoc(
        doc(db, path),
        decodeFirestoreMapForSdk(operation.data ?? {}, refDecoder),
      );
      return null;
    case "delete":
      await deleteDoc(doc(db, path));
      return null;
  }
}

export async function executeRtdb(
  operation: FirebaseOperation,
  db: Database,
): Promise<unknown> {
  if (operation.service !== "rtdb") {
    throw new Error("Expected an RTDB operation.");
  }
  const target = rtdbRef(db, operation.path);
  switch (operation.method) {
    case "get": {
      const constraints: RtdbQueryConstraint[] = [];
      const querySpec = operation.query;
      if (querySpec?.orderBy?.kind === "child") {
        constraints.push(orderByChildRtdb(querySpec.orderBy.path));
      } else if (querySpec?.orderBy?.kind === "key") {
        constraints.push(orderByKeyRtdb());
      } else if (querySpec?.orderBy?.kind === "value") {
        constraints.push(orderByValueRtdb());
      }
      if (querySpec?.startAt) {
        constraints.push(
          startAtRtdb(toRtdbCursorValue(querySpec.startAt.value), querySpec.startAt.key),
        );
      }
      if (querySpec?.startAfter) {
        constraints.push(
          startAfterRtdb(
            toRtdbCursorValue(querySpec.startAfter.value),
            querySpec.startAfter.key,
          ),
        );
      }
      if (querySpec?.endAt) {
        constraints.push(
          endAtRtdb(toRtdbCursorValue(querySpec.endAt.value), querySpec.endAt.key),
        );
      }
      if (querySpec?.endBefore) {
        constraints.push(
          endBeforeRtdb(
            toRtdbCursorValue(querySpec.endBefore.value),
            querySpec.endBefore.key,
          ),
        );
      }
      if (querySpec?.equalTo) {
        constraints.push(
          equalToRtdb(toRtdbCursorValue(querySpec.equalTo.value), querySpec.equalTo.key),
        );
      }
      if (querySpec?.limitToFirst !== undefined) {
        constraints.push(limitToFirstRtdb(querySpec.limitToFirst));
      }
      if (querySpec?.limitToLast !== undefined) {
        constraints.push(limitToLastRtdb(querySpec.limitToLast));
      }
      if (constraints.length > 0) {
        return (await getRtdb(queryRtdb(target, ...constraints))).val();
      }
      return (await getRtdb(target)).val();
    }
    case "set":
      await setRtdb(target, operation.data);
      return null;
    case "update":
      if (
        !operation.data ||
        typeof operation.data !== "object" ||
        Array.isArray(operation.data)
      ) {
        throw new Error("RTDB update data must be an object.");
      }
      await updateRtdb(target, operation.data as Record<string, unknown>);
      return null;
    case "remove":
      await removeRtdb(target);
      return null;
  }
}

function buildStorageWriteMetadata(operation: StorageOperation): {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: Record<string, string>;
} {
  const metadata: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
    customMetadata?: Record<string, string>;
  } = {};
  if (operation.contentType !== undefined) metadata.contentType = operation.contentType;
  if (operation.cacheControl !== undefined) metadata.cacheControl = operation.cacheControl;
  if (operation.contentDisposition !== undefined) {
    metadata.contentDisposition = operation.contentDisposition;
  }
  if (operation.contentEncoding !== undefined) {
    metadata.contentEncoding = operation.contentEncoding;
  }
  if (operation.contentLanguage !== undefined) {
    metadata.contentLanguage = operation.contentLanguage;
  }
  if (operation.customMetadata) {
    metadata.customMetadata = { ...operation.customMetadata };
  }
  return metadata;
}

export async function executeStorage(
  operation: StorageOperation,
  storage: FirebaseStorage,
): Promise<unknown> {
  const target = storageRef(storage, operation.path);
  switch (operation.method) {
    case "get": {
      try {
        const [blob, metadata] = await Promise.all([
          getBlob(target),
          getMetadata(target),
        ]);
        return projectStorageObject(await blob.arrayBuffer(), metadata);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === "storage/object-not-found") return null;
        throw error;
      }
    }
    case "list": {
      const result = await listAll(target);
      return {
        items: result.items.map((item) => item.fullPath),
        prefixes: result.prefixes.map((item) => item.fullPath),
      };
    }
    case "upload": {
      if (!operation.dataBase64) {
        throw new Error("Storage upload requires dataBase64.");
      }
      const result = await uploadBytes(
        target,
        decodeBase64(operation.dataBase64),
        buildStorageWriteMetadata(operation),
      );
      return result.metadata;
    }
    case "updateMetadata": {
      return updateMetadata(target, buildStorageWriteMetadata(operation));
    }
    case "delete":
      await deleteObject(target);
      return null;
  }
}
