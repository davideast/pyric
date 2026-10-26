import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

// Exits on its own, without process.exit, so anything left holding the event
// loop shows up as the time the process takes to end.
initializeApp();
try {
  await getDatabase().ref("status").set("never written");
  console.log("write landed");
} catch (error) {
  console.log(`write refused: ${error.message}`);
}
console.log(`refused at ${Date.now()}`);
