// A worker-thread SSR runner (#1144), the isolate shape Nuxt's vite-node uses:
// loads the routed client and firebase-admin targets through
// @pyric/cli/vite/ssr-loader inside a worker_threads.Worker.
import { parentPort, workerData } from "node:worker_threads";
import { loadServerTarget } from "@pyric/cli/vite/ssr-loader";
import { config } from "./src/config.js";

const TIMEOUT_MS = 10_000;

async function outcome(run) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("did not settle"), { code: "timeout" })), TIMEOUT_MS);
  });
  try {
    return { ok: true, value: (await Promise.race([run(), timeout])) ?? null };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

const tag = workerData?.tag ?? "worker";
const out = {};

const clientAppMod = await loadServerTarget("@pyric/cli/register/client/app");
const clientAuthMod = await loadServerTarget("@pyric/cli/register/client/auth");
const clientDbMod = await loadServerTarget("@pyric/cli/register/client/database");
const clientFsMod = await loadServerTarget("@pyric/cli/register/client/firestore");

const app = clientAppMod.getApps()[0] ?? clientAppMod.initializeApp(config);
const auth = clientAuthMod.getAuth(app);
out["worker.auth"] = await outcome(async () =>
  (auth.currentUser ?? (await clientAuthMod.signInAnonymously(auth)).user).uid);
const uid = out["worker.auth"].ok ? out["worker.auth"].value : "no-user";

out["worker.database"] = await outcome(async () => {
  const db = clientDbMod.getDatabase(app);
  await clientDbMod.set(clientDbMod.ref(db, `users/${uid}/${tag}`), { from: "worker-ssr" });
  return (await clientDbMod.get(clientDbMod.ref(db, `users/${uid}/${tag}`))).val();
});

out["worker.firestore"] = await outcome(async () => {
  const fs = clientFsMod.getFirestore(app);
  await clientFsMod.setDoc(clientFsMod.doc(fs, "users", uid, "notes", tag), { from: "worker-ssr" });
  return (await clientFsMod.getDoc(clientFsMod.doc(fs, "users", uid, "notes", tag))).data() ?? null;
});

const adminAppMod = await loadServerTarget("pyric-admin/app");
const adminDbMod = await loadServerTarget("pyric-admin/database");
const adminFsMod = await loadServerTarget("pyric-admin/firestore");

out["worker.adminDatabase"] = await outcome(async () => {
  const admin = adminAppMod.getApps()[0] ?? adminAppMod.initializeApp({
    projectId: config.projectId,
    databaseURL: config.databaseURL,
    storageBucket: config.storageBucket,
  });
  return (await adminDbMod.getDatabase(admin).ref(`users/${uid}/${tag}`).get()).val();
});

out["worker.adminFirestore"] = await outcome(async () => {
  const admin = adminAppMod.getApps()[0];
  return (await adminFsMod.getFirestore(admin).doc(`users/${uid}/notes/${tag}`).get()).data() ?? null;
});

parentPort?.postMessage({ uid, outcomes: out });
