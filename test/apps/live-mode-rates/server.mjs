// The bookings app's server job. It lists the bookings. Its Firebase backend
// is the project below, or the local backend BOOKINGS_FIRESTORE_HOST names,
// through the SDK's own emulator connector.
import { deleteApp, initializeApp } from "firebase/app";
import { collection, connectFirestoreEmulator, getDocs, getFirestore, terminate } from "firebase/firestore";

const PROJECT = "demo-live-traffic";
const app = initializeApp({ projectId: PROJECT, apiKey: "demo-live-traffic-key", appId: "1:1:web:live-traffic" });
const db = getFirestore(app);
const firestoreHost = process.env.BOOKINGS_FIRESTORE_HOST;
if (firestoreHost) {
  const [host, port] = firestoreHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
}

const failure = (error) => error.code ?? String(error);
const bookings = await getDocs(collection(db, "bookings")).then((snapshot) => snapshot.docs.map((booking) => booking.id), failure);

await terminate(db);
await deleteApp(app);
console.log(`RESULT ${JSON.stringify({ bookings })}`);
