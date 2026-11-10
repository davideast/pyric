// Backend check under real `require-in-the-middle` + `@pyric/live/register`:
// verifies `firebase-admin` services load with zero `PYRIC_REAL_SDK_STOPPED`
// output and still observe Admin Auth, Firestore (including AggregateQuery),
// and Storage calls, while ADR 0022 still stops direct and forged SDK loads.
import "./trap.mjs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const PROJECT = "demo-instrumented-backend";

const stub = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url?.startsWith("/v1/projects/")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Denied" } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 404, message: "USER_NOT_FOUND" } }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const { port } = stub.address();

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${port}`;
process.env.FIRESTORE_PREFER_REST = "true";
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${port}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${port}`;

const { initializeApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const { getFirestore } = await import("firebase-admin/firestore");
const { getDatabase } = await import("firebase-admin/database");
const { getStorage } = await import("firebase-admin/storage");

const app = initializeApp(
  {
    projectId: PROJECT,
    databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
    storageBucket: `${PROJECT}.appspot.com`,
  },
  "ritm-check",
);

const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);
rtdb.ref("orders/a");
rtdb.goOffline();
const bucket = getStorage(app).bucket();

await auth.getUser("order-owner").catch(() => {});
await db.doc("orders/a").get().catch(() => {});
await db.collection("orders").count().get().catch(() => {});
await db.terminate().catch(() => {});
await bucket.file("orders/a.txt").getMetadata().catch(() => {});

let stops = null;
if (process.env.CHECK_STOPS === "1") {
  const appRequire = createRequire(import.meta.url);
  const ritmEntry = appRequire.resolve("require-in-the-middle");
  const adminFirestoreEntry = appRequire.resolve("firebase-admin/firestore");
  const forgedRitmRequire = createRequire(ritmEntry);
  const forgedAdminRequire = createRequire(adminFirestoreEntry);
  const adminDir = dirname(adminFirestoreEntry);

  const catchSync = (fn) => {
    try {
      fn();
      return "ALLOWED";
    } catch (error) {
      return error?.code ?? String(error);
    }
  };
  const catchAsync = async (fn) => {
    try {
      await fn();
      return "ALLOWED";
    } catch (error) {
      return error?.code ?? String(error);
    }
  };

  let getterInnerLoad = "NOT_RUN";
  const forgedRitmFrame = vm.runInThisContext(
    "(function(ritmReq, spec, runInner, dir) { return ritmReq.resolve(spec, { get paths() { runInner(); return [dir]; } }); })",
    { filename: ritmEntry },
  );
  const forgedAdminFrame = vm.runInThisContext("(function(invoke) { return invoke(); })", {
    filename: adminFirestoreEntry,
  });
  const getterOuterResolve = catchSync(() =>
    forgedAdminFrame(() =>
      forgedRitmFrame(
        forgedRitmRequire,
        "@google-cloud/firestore",
        () => {
          getterInnerLoad = catchSync(() => forgedRitmRequire("@google-cloud/firestore"));
        },
        adminDir,
      ),
    ),
  );

  stops = {
    cjsFirestore: catchSync(() => appRequire("@google-cloud/firestore")),
    esmFbUtil: await catchAsync(() => import("@firebase/util")),
    forgedRitmLoad: catchSync(() => forgedRitmRequire("@google-cloud/firestore")),
    forgedAdminLoad: catchSync(() => forgedAdminRequire("@google-cloud/firestore")),
    getterInnerLoad,
    getterOuterResolve,
  };
}

async function waitForObservedAdminCalls(hostUrl, beforeCount) {
  const { token: sessionToken } = JSON.parse(readFileSync(".pyric/serve.json", "utf8"));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const capRes = await fetch(`${hostUrl}/__pyric/capture`, {
      headers: { "x-pyric-session-token": sessionToken },
    });
    if (capRes.status === 200) {
      const cap = await capRes.json();
      const adminEvents = (cap.events ?? [])
        .filter((e) => e.kind === "operation" && e.detail?.sdk === "admin")
        .slice(beforeCount);
      const methods = new Set(adminEvents.map((e) => e.method));
      if (
        methods.has("Auth.getUser") &&
        methods.has("DocumentReference.get") &&
        methods.has("AggregateQuery.get") &&
        methods.has("File.getMetadata")
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

if (process.env.LIVE_HOST_URL && process.env.CHECK_STOPS !== "1") {
  await waitForObservedAdminCalls(process.env.LIVE_HOST_URL, Number(process.env.BEFORE_ADMIN_EVENTS ?? "0"));
}
stub.close();

const hooked = [...new Set(globalThis[Symbol.for("live.instrumented.ritm")] ?? [])].sort();
console.log(`RITM_OUTCOME ${JSON.stringify({ hooked, stops })}`);
process.exit(0);
