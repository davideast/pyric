// An app that picks its sign-in screen or its signed-in screen from the first
// onAuthStateChanged value, as most apps do.
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const auth = getAuth(app);

const observed = [];
onAuthStateChanged(auth, (user) => {
  observed.push(user ? user.uid : null);
});

window.authState = {
  observed: () => [...observed],
  signIn: async () => (await signInAnonymously(auth)).user.uid,
};
