/**
 * Pins matrix row Firestore #99.
 *
 * Single claim: a `serverTimestamp()` field resolves to a
 * `Timestamp` instance after the write commits (round-trips through
 * setDoc → getDoc).
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-99-servertimestamp-resolves";

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
        await setDoc(ref, { createdAt: serverTimestamp() });
        const snap = await getDoc(ref);
        const data = snap.data() as { createdAt: unknown };
        assert(data.createdAt instanceof Timestamp,
          `createdAt should be a Timestamp instance (got ${Object.prototype.toString.call(data.createdAt)})`);
        say("serverTimestamp resolved to Timestamp");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
