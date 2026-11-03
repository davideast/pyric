// A package of the app's own that uses firebase-admin, the shape of a shared
// data layer. The scenario copies it into node_modules, so Vite externalizes
// it for server rendering and Node loads it, and its firebase-admin/app
// import, itself: the plugin's swap never sees that import.
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const TIMEOUT_MS = 10_000;

/** Reads a user with admin rights. With the real firebase-admin this needs a Google access token. */
export async function readUser(uid) {
  const app = getApps().find((each) => each.name === "local-admin-lib") ??
    initializeApp({ projectId: "demo-app" }, "local-admin-lib");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("did not settle")), TIMEOUT_MS);
  });
  try {
    return await Promise.race([getAuth(app).getUser(uid), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
