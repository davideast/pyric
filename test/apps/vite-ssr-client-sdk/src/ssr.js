// A module Vite loads for server rendering, the way a framework's loader
// would. `run` signs in and calls each client SDK as that user; `runAiOnly`
// calls only firebase/ai. Each outcome is one entry: { ok, value } or
// { ok: false, code, message }. A call that never settles is reported as
// `timeout` after 10 s, so a call that hangs still fails its step.
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get } from "firebase/database";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadString, getDownloadURL } from "firebase/storage";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
import { getMessaging } from "firebase/messaging";
import { config } from "./config.js";

const TIMEOUT_MS = 10_000;

function appOnce() {
  return getApps()[0] ?? initializeApp(config);
}

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

export async function run(tag) {
  const app = appOnce();
  const out = {};
  const auth = getAuth(app);
  out["auth.signIn"] = await outcome(async () => (auth.currentUser ?? (await signInAnonymously(auth)).user).uid);
  const uid = out["auth.signIn"].ok ? out["auth.signIn"].value : "no-user";

  const db = getDatabase(app);
  out["database.ownPath"] = await outcome(() => set(ref(db, `users/${uid}/${tag}`), { from: "ssr" }));
  out["database.readBack"] = await outcome(async () => (await get(ref(db, `users/${uid}/${tag}`))).val());
  out["database.otherPath"] = await outcome(() => set(ref(db, `users/someone-else/${tag}`), { from: "ssr" }));

  const firestore = getFirestore(app);
  out["firestore.ownPath"] = await outcome(() => setDoc(doc(firestore, "users", uid, "notes", tag), { from: "ssr" }));
  out["firestore.readBack"] = await outcome(async () => (await getDoc(doc(firestore, "users", uid, "notes", tag))).data() ?? null);
  out["firestore.otherPath"] = await outcome(() => setDoc(doc(firestore, "users", "someone-else", "notes", tag), { from: "ssr" }));

  const storage = getStorage(app);
  out["storage.ownPath"] = await outcome(async () =>
    (await uploadString(storageRef(storage, `users/${uid}/${tag}.txt`), "ssr")).metadata.fullPath);
  out["storage.url"] = await outcome(async () =>
    new URL(await getDownloadURL(storageRef(storage, `users/${uid}/${tag}.txt`))).pathname);
  out["storage.otherPath"] = await outcome(() => uploadString(storageRef(storage, `users/someone-else/${tag}.txt`), "ssr"));

  out["ai"] = await outcome(() => generate(app));
  out["messaging"] = await outcome(() => getMessaging(app));
  return { uid, outcomes: out };
}

function generate(app) {
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: "gemini-2.5-flash-lite" });
  return model.generateContent("ping").then(() => "generated");
}

/** Only the firebase/ai call, for a dev server in production AI mode. */
export async function runAiOnly() {
  return { outcomes: { ai: await outcome(() => generate(appOnce())) } };
}
