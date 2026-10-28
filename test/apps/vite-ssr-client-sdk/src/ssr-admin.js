// A server-rendered module that uses firebase-admin, as a framework loader
// that reads data with admin rights would. It reads what a user wrote under
// users/<uid>, which the rules let only that user read, and what the browser
// wrote under ssr/browser.
import { initializeApp, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { config } from "./config.js";

const TIMEOUT_MS = 10_000;

function appOnce() {
  return getApps()[0] ?? initializeApp({
    projectId: config.projectId,
    databaseURL: config.databaseURL,
    storageBucket: config.storageBucket,
  });
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

export async function read(uid, tag) {
  const out = {};
  out["admin.database"] = await outcome(async () => (await getDatabase(appOnce()).ref(`users/${uid}/${tag}`).get()).val());
  out["admin.firestore"] = await outcome(async () =>
    (await getFirestore(appOnce()).doc(`users/${uid}/notes/${tag}`).get()).data() ?? null);
  out["admin.browser"] = await outcome(async () => (await getDatabase(appOnce()).ref("ssr/browser").get()).val());
  return { outcomes: out };
}
