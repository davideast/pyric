import { db, base } from "../data";
import { doc, setDoc } from "firebase/firestore";
export async function seedVersions() {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [i, id] of ids.entries()) {
    await setDoc(doc(db, `${base}/apps/${id}`), {
      ownerId: "emma",
      title: `Existing app ${i}`,
      prompt: "",
      source: "",
      context: "{}",
      audience: ["emma"],
      createdAt: Date.now(),
      published: false,
      activeVersionId: null,
      deletedAt: null,
    });
    await setDoc(doc(db, `${base}/apps/${id}/versions/version-${i}`), {
      number: 1,
      title: `Existing app ${i}`,
      prompt: "A saved app",
      audience: ["emma"],
      baseVersionId: null,
      buildId: "fixture",
      model: "fixture",
      sourceHash: "fixture",
      dataSchemaVersion: 1,
      createdAt: Date.now(),
    });
    if (i !== 2)
      await setDoc(
        doc(db, `${base}/apps/${id}/versions/version-${i}/artifacts/source`),
        {
          source: `export default function App(){return <h1>Saved content ${i}</h1>}`,
          entrypoint: "App.tsx",
          runtimeContractVersion: 1,
        },
      );
    await setDoc(
      doc(db, `${base}/apps/${id}/versions/version-${i}/artifacts/context`),
      {
        snapshot: "{}",
        capturedAt: Date.now(),
        recipientIds: ["emma"],
      },
    );
  }
  return ids;
}

export async function restoreMissingSource(id: string) {
  await setDoc(
    doc(db, `${base}/apps/${id}/versions/version-2/artifacts/source`),
    {
      source:
        "export default function App(){return <h1>Recovered saved content</h1>}",
      entrypoint: "App.tsx",
      runtimeContractVersion: 1,
    },
  );
}
