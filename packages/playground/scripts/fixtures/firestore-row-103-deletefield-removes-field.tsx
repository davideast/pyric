/**
 * Pins matrix row Firestore #103.
 *
 * Single claim: `deleteField()` removes a field from the document
 * (subsequent `getDoc` returns `data()[field] === undefined`).
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc, deleteField } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-103-deletefield-removes-field";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "stats", a.user.uid);
        await setDoc(ref, { keep: 1, obsolete: "removeme" });
        await updateDoc(ref, { obsolete: deleteField() });
        const snap = await getDoc(ref);
        const data = snap.data() as { keep: number; obsolete?: string };
        assert(data.obsolete === undefined,
          `obsolete should be deleted (got ${JSON.stringify(data.obsolete)})`);
        assert(data.keep === 1, `unrelated 'keep' field should survive (got ${data.keep})`);
        say("deleteField removed only the targeted field");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
