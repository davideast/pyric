import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as functionsV1 from "firebase-functions/v1";

if (getApps().length === 0) {
  initializeApp();
}

export const saveItem = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const title = String(request.data?.title ?? "");
  if (title.length === 0) {
    throw new HttpsError("invalid-argument", "Title must be non-empty.", { field: "title" });
  }
  const ref = await getFirestore().collection("items").add({
    title,
    ownerUid: request.auth.uid,
  });
  return { id: ref.id, ownerUid: request.auth.uid };
});

export const streamItems = onCall({ heartbeatSeconds: 5 }, async (request, response) => {
  const total = Number(request.data?.count ?? 2);
  for (let index = 1; index <= total; index += 1) {
    if (request.acceptsStreaming && response) {
      await response.sendChunk({ index });
    }
  }
  return { sent: total };
});

export const legacyEcho = functionsV1.https.onCall((data, context) => ({
  data,
  uid: context.auth?.uid ?? null,
}));
