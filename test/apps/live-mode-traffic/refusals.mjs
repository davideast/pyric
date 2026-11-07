// Calls a server job might make that live mode does not serve: another
// Firebase service, a named Firestore database, Google's server Firestore
// client, and a raw https.request to Firestore's REST API. The Admin SDK
// loads where live mode observes it (Node 23 or later) and is refused on
// Node 22.
// Each outcome is printed: the error it threw, or what it returned.
import { readFileSync } from "node:fs";
import https from "node:https";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const config = JSON.parse(readFileSync(new URL("./firebase-config.json", import.meta.url), "utf8"));
const outcome = (error) => `${error.code}: ${error.message}`;
const result = {};
result.functions = await import("firebase/functions").then(() => "loaded", outcome);
result.admin = await import("firebase-admin/firestore").then(() => "loaded", outcome);
result.cloudFirestore = await import("@google-cloud/firestore").then(() => "loaded", outcome);
const app = initializeApp(config);
try {
  getFirestore(app, "reports");
  result.namedDatabase = "opened";
} catch (error) {
  result.namedDatabase = outcome(error);
}
const lobby = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/rooms/lobby`;
result.httpsRequest = await new Promise((resolve) => {
  const request = https.request(lobby, { method: "PATCH", headers: { "content-type": "application/json" } }, () => resolve("sent"));
  request.on("error", (error) => resolve(outcome(error)));
  request.end(JSON.stringify({ fields: { open: { booleanValue: false } } }));
});
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
