// `node admin.mjs seed` writes server/fromAdmin on the Node host with
// firebase-admin; `node admin.mjs` reads back what the client SDKs wrote.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import {
  Auth,
  AuthErrorCode,
  BaseAuth,
  FirebaseAuthError,
  UserInfo,
  UserMetadata,
  UserRecord,
  getAuth,
} from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const app = initializeApp({
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

async function outcome(name, run) {
  try {
    console.log(`${name} ${JSON.stringify({ ok: true, value: (await run()) ?? null })}`);
  } catch (error) {
    console.log(`${name} ${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })}`);
  }
}

if (process.argv[2] === "seed") {
  await outcome("admin.seed.database", () => getDatabase(app).ref("server/fromAdmin").set("from admin"));
  await outcome("admin.seed.firestore", () => getFirestore(app).doc("server/fromAdmin").set({ from: "admin" }));
  await outcome("admin.seed.bulkWriter", async () => {
    const fs = getFirestore(app);
    const bw = fs.bulkWriter({ throttling: false });
    const seenPaths = [];
    bw.onWriteResult((ref, res) => {
      if (typeof res?.writeTime?.seconds === "number") {
        seenPaths.push(ref.path);
      }
    });
    const docRef = fs.doc("adminBulkWriter/fromBulkWriter");
    const pCreate = bw.create(docRef, { seededBy: "bulkWriter", step: 1 });
    const pUpdate = bw.update(docRef, { step: 2 });
    await bw.flush();
    const [createRes, updateRes] = await Promise.all([pCreate, pUpdate]);
    let duplicateErrorShape = null;
    try {
      await bw.create(docRef, { seededBy: "duplicate" });
    } catch (dupErr) {
      duplicateErrorShape = {
        isError: dupErr instanceof Error,
        code: dupErr?.code ?? null,
        path: dupErr?.documentRef?.path ?? null,
        operationType: dupErr?.operationType ?? null,
        failedAttempts: dupErr?.failedAttempts ?? null,
      };
    }
    const closeFirst = bw.close();
    const closeSecond = bw.close();
    await closeFirst;
    let postCloseFlushThrewSync = false;
    try {
      bw.flush();
    } catch (flushError) {
      if (
        flushError instanceof Error &&
        flushError.message === "BulkWriter has already been closed."
      ) {
        postCloseFlushThrewSync = true;
      } else {
        throw flushError;
      }
    }
    return {
      seenPaths,
      hasWriteTimes:
        typeof createRes?.writeTime?.seconds === "number" &&
        typeof updateRes?.writeTime?.seconds === "number",
      duplicateErrorShape,
      closeIdempotent: closeFirst === closeSecond,
      postCloseFlushThrewSync,
    };
  });
} else {
  const db = getDatabase(app);
  const auth = getAuth(app);
  const user = await auth.getUserByEmail("node@example.com").catch(() => null);
  const missingErr = await auth.getUser("missing-node-uid").catch((err) => err);
  await outcome("admin.database", async () => (await db.ref("server/client").get()).val());
  await outcome("admin.firestore", async () => (await getFirestore(app).doc("server/client").get()).data() ?? null);
  await outcome("admin.bulkWriter", async () => (await getFirestore(app).doc("adminBulkWriter/fromBulkWriter").get()).data() ?? null);
  await outcome("admin.auth", async () => user?.email ?? null);
  await outcome("admin.auth.exports", async () => ({
    authInstance: auth instanceof Auth && auth instanceof BaseAuth,
    recordInstance:
      user instanceof UserRecord &&
      user.metadata instanceof UserMetadata &&
      user.providerData[0] instanceof UserInfo,
    errorInstance:
      missingErr instanceof FirebaseAuthError &&
      missingErr.hasCode(AuthErrorCode.USER_NOT_FOUND),
  }));
  await outcome("admin.ownPath", async () => (await db.ref(`users/${user?.uid}`).get()).val());
  await outcome("admin.otherPath", async () => (await db.ref("users/someone-else").get()).val());
  await outcome("admin.presence", async () => (await db.ref("server/presence").get()).val());
  await outcome("admin.storage", async () => (await getStorage(app).bucket().file("server/client.txt").download())[0].toString());
  await outcome("admin.cjs", async () => (await db.ref("server/cjs").get()).val());
}
process.exit(0);
