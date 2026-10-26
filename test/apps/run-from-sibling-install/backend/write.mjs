import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

initializeApp();
await getDatabase().ref("status").set(process.argv[2]);
console.log(`status set to ${process.argv[2]}`);
process.exit(0);
