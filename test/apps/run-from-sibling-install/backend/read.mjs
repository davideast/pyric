import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

initializeApp();
const snapshot = await getDatabase().ref("status").get();
console.log(`status is ${snapshot.val()}`);
process.exit(0);
