/**
 * Pins matrix row Firestore #102.
 *
 * Single claim: `arrayRemove(...values)` strips matching members
 * from the array (leaves non-matching members alone).
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc, arrayRemove } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-102-arrayremove-strips";

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
        await setDoc(ref, { tags: ["a", "b", "c"] });
        await updateDoc(ref, { tags: arrayRemove("a") });
        const snap = await getDoc(ref);
        const data = snap.data() as { tags: string[] };
        assert(!data.tags.includes("a"), `'a' should be removed (got [${data.tags.join(",")}])`);
        assert(data.tags.includes("b") && data.tags.includes("c"),
          `'b' and 'c' should remain (got [${data.tags.join(",")}])`);
        assert(data.tags.length === 2, `tags should have 2 entries (got ${data.tags.length})`);
        say(`arrayRemove stripped 'a': tags=[${data.tags.join(",")}]`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
