import { initializeApp } from "firebase/app";
import { getMessaging } from "firebase/messaging";

const app = initializeApp({
  apiKey: "demo",
  appId: "1:1234567890:web:demo",
  projectId: "demo-app",
  messagingSenderId: "1234567890",
});

// Initializing Messaging reports this tab's visibility to the host.
getMessaging(app);
window.messagingReady = true;
