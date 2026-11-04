// Calls a server job might make that live mode does not serve: another
// Firebase service, a named Firestore database, and the Admin SDK. Each
// outcome is printed: the error it threw, or what it returned.
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const config = JSON.parse(readFileSync(new URL("./firebase-config.json", import.meta.url), "utf8"));
const outcome = (error) => `${error.code}: ${error.message}`;
const result = {};
result.storage = await import("firebase/storage").then(() => "loaded", outcome);
result.admin = await import("firebase-admin/firestore").then(() => "loaded", outcome);
const app = initializeApp(config);
try {
  getFirestore(app, "reports");
  result.namedDatabase = "opened";
} catch (error) {
  result.namedDatabase = outcome(error);
}
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
