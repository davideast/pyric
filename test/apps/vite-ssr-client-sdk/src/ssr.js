// A module Vite loads for server rendering, the way a framework's loader
// would. Each call is started and its outcome recorded as it settles.
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set } from "firebase/database";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadString } from "firebase/storage";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
import { config } from "./config.js";

const runs = new Map();

function track(outcomes, label, operation) {
  const startedAt = Date.now();
  outcomes[label] = { state: "pending" };
  Promise.resolve()
    .then(operation)
    .then(
      () => { outcomes[label] = { state: "resolved", ms: Date.now() - startedAt }; },
      (error) => {
        outcomes[label] = { state: "rejected", code: error?.code ?? null, message: String(error?.message ?? error), ms: Date.now() - startedAt };
      },
    );
}

export function start(tag) {
  const app = getApps()[0] ?? initializeApp(config);
  const outcomes = {};
  runs.set(tag, outcomes);
  track(outcomes, "auth.signInAnonymously", () => signInAnonymously(getAuth(app)));
  track(outcomes, "database.set", () => set(ref(getDatabase(app), `ssr/${tag}`), { from: "ssr" }));
  track(outcomes, "firestore.setDoc", () => setDoc(doc(getFirestore(app), "ssr", tag), { from: "ssr" }));
  track(outcomes, "storage.uploadString", () => uploadString(storageRef(getStorage(app), `ssr/${tag}.txt`), "ssr"));
  startAi(app, outcomes);
  return outcomes;
}

function startAi(app, outcomes) {
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: "gemini-2.5-flash-lite" });
  track(outcomes, "ai.generateContent", () => model.generateContent("ping"));
}

/** Only the firebase/ai call, for a dev server in production AI mode. */
export function startAiOnly(tag) {
  const app = getApps()[0] ?? initializeApp(config);
  const outcomes = {};
  runs.set(tag, outcomes);
  startAi(app, outcomes);
  return outcomes;
}

export function status(tag) {
  return runs.get(tag) ?? null;
}
