// The rooms app's server job. It lists the bookings and resumes a listener
// from that list (`QuerySnapshot.toJSON()`, which only the Node build can
// make). Its Firebase backend is the project below, or the local backend
// BOOKINGS_FIRESTORE_HOST names, through the SDK's own emulator connector.
import { deleteApp, initializeApp } from "firebase/app";
import { collection, connectFirestoreEmulator, getDocs, getFirestore, onSnapshotResume, terminate } from "firebase/firestore";

const PROJECT = "demo-live-traffic";
const app = initializeApp({ projectId: PROJECT, apiKey: "demo-live-traffic-key", appId: "1:1:web:live-batch" });
const db = getFirestore(app);
const firestoreHost = process.env.BOOKINGS_FIRESTORE_HOST;
if (firestoreHost) {
  const [host, port] = firestoreHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
}

const failure = (error) => error.code ?? String(error);
const listed = await getDocs(collection(db, "bookings"));
// The documents production billed the resumed listener for: each document a
// snapshot changed, at least one for the first.
let billedDocuments = 0;
let snapshots = 0;
let stop = () => {};
const bookings = await new Promise((resolve, reject) => {
  stop = onSnapshotResume(db, listed.toJSON(), { includeMetadataChanges: true }, {
    next: (snapshot) => {
      const changed = snapshot.docChanges().length;
      billedDocuments += snapshots === 0 ? Math.max(changed, 1) : changed;
      snapshots += 1;
      if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) resolve(snapshot.docs.map((booking) => booking.id));
    },
    error: (error) => reject(failure(error)),
  });
}).catch((error) => error);
stop();

await terminate(db);
await deleteApp(app);
console.log(`RESULT ${JSON.stringify({ bookings, billedDocuments })}`);
