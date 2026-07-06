/**
 * Pins matrix row Firestore #100.
 *
 * Single claim: `increment(n)` atomically bumps an existing numeric
 * field by `n` (and from 0 when the field is missing).
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc, increment } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-100-increment-bumps-numeric";

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
        await setDoc(ref, { count: 5 });
        await updateDoc(ref, { count: increment(3) });
        const snap = await getDoc(ref);
        const data = snap.data() as { count: number };
        assert(data.count === 8, `count should be 8 after increment(3) on 5 (got ${data.count})`);
        say(`increment(3) on 5 → ${data.count}`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
