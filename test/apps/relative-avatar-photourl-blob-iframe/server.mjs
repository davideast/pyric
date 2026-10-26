// Reads the signed-in user through firebase-admin and prints its photoURL.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const uid = process.argv[2];
if (!uid) throw new Error("usage: node server.mjs <uid>");

const user = await getAuth(initializeApp({ projectId: "demo-app" })).getUser(uid);
console.log(JSON.stringify({ photoURL: user.photoURL ?? null }));
