// Server-side Storage seed job for `verify-observed-browser.ts`: exercises
// `firebase-admin/storage` on Node >= 23 (and falls back to client SDK on Node
// 22 where `@pyric/live/register` refuses `firebase-admin` by design).
const PROJECT = "demo-live-storage";
const SECOND_BUCKET = `${PROJECT}-live-second`;
const PAYLOAD = '{"ok":true}\n';

if (process.env.SEED_MODE === "admin") {
  const { initializeApp } = await import("firebase-admin/app");
  const { getStorage } = await import("firebase-admin/storage");
  const app = initializeApp({
    projectId: PROJECT,
    storageBucket: `${PROJECT}.firebasestorage.app`,
  });
  const secondBucket = getStorage(app).bucket(SECOND_BUCKET);
  const report = secondBucket.file("exports/monthly/report.json");
  await report.save(PAYLOAD, {
    resumable: false,
    contentType: "application/json",
  });
  await report.setMetadata({
    metadata: {
      generatedBy: "worker",
      apiKey: "sk-secret-999",
    },
  });
  console.log("ADMIN_SEED ok");
} else {
  const { deleteApp, initializeApp } = await import("firebase/app");
  const { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } = await import("firebase/auth");
  const { connectStorageEmulator, getMetadata, getStorage, ref, uploadString } = await import("firebase/storage");
  const replayUrl = new URL(process.env.STORAGE_EMULATOR_HOST);
  const app = initializeApp(
    {
      projectId: PROJECT,
      apiKey: "demo-live-storage-key",
      appId: "1:1:web:live-storage",
      authDomain: `${PROJECT}.firebaseapp.com`,
      storageBucket: `${PROJECT}.firebasestorage.app`,
    },
    "catalog-node-fallback",
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, replayUrl.origin, { disableWarnings: true });
  await signInWithCustomToken(auth, "client-1");
  const storage = getStorage(app, `gs://${SECOND_BUCKET}`);
  connectStorageEmulator(storage, replayUrl.hostname, Number(replayUrl.port));
  const reportRef = ref(storage, "exports/monthly/report.json");
  await uploadString(reportRef, PAYLOAD, "raw", { contentType: "application/json" });
  await getMetadata(reportRef);
  await signOut(auth);
  await deleteApp(app);
  console.log("CLIENT_FALLBACK_SEED ok");
}
