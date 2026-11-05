// A notes app's Firebase init module: one file that sets up every service the
// app uses, as many apps write it. Realtime Database is its data store and AI
// Logic drafts notes. Nothing here reads, writes or sends a prompt: getting
// each service makes no request.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getAI } from "firebase/ai";

const app = initializeApp({
  apiKey: "demo-api-key",
  authDomain: "demo-live-pass-through.firebaseapp.com",
  databaseURL: "https://demo-live-pass-through-default-rtdb.firebaseio.com",
  projectId: "demo-live-pass-through",
  appId: "1:123456789012:web:0a1b2c3d4e5f6071",
});
const auth = getAuth(app);
const database = getDatabase(app);
const ai = getAI(app);

const services = [
  ["auth", auth.app === app],
  ["database", database.app === app],
  ["ai", ai.app === app],
];
document.querySelector("#services").innerHTML = services
  .map(([name, sameApp]) => `<li data-service="${name}">${name}: ${sameApp ? "ready" : "another app"}</li>`)
  .join("");
document.querySelector("#status").textContent = "Ready";
