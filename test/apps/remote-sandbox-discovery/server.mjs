import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const status = process.argv[2] ?? "ok";
initializeApp();
await getDatabase().ref("status").set(status);
console.log(`status set to ${status}`);
process.exit(0);
