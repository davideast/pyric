/**
 * Pins matrix row Firestore #101.
 *
 * Single claim: `arrayUnion(...values)` adds new members and de-dupes
 * against existing members (re-adding "a" does not duplicate it).
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-101-arrayunion-dedupes";

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
        await setDoc(ref, { tags: ["a", "b"] });
        // Add a new "c" and re-add existing "a" — the "a" must NOT duplicate.
        await updateDoc(ref, { tags: arrayUnion("c", "a") });
        const snap = await getDoc(ref);
        const data = snap.data() as { tags: string[] };
        assert(
          data.tags.length === 3,
          `tags should have 3 entries after union (got ${data.tags.length}: [${data.tags.join(",")}])`,
        );
        assert(data.tags.includes("a") && data.tags.includes("b") && data.tags.includes("c"),
          `tags should contain a,b,c (got [${data.tags.join(",")}])`);
        const aCount = data.tags.filter((t) => t === "a").length;
        assert(aCount === 1, `'a' should appear exactly once (got ${aCount})`);
        say(`arrayUnion deduped: tags=[${data.tags.join(",")}]`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
