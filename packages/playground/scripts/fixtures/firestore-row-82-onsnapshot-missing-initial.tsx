/**
 * Pins matrix row Firestore #82.
 *
 * Single claim: the initial `onSnapshot` fire for a missing doc has
 * `exists() === false` and `data() === undefined`.
 */
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-82-onsnapshot-missing-initial";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "notes", a.user.uid);

        const observed: Array<{ exists: boolean; data: unknown }> = [];
        unsub = onSnapshot(ref, (s) => {
          const exists = typeof s.exists === "function" ? (s.exists as () => boolean)() : Boolean(s.exists);
          observed.push({ exists, data: s.data() });
        });

        await new Promise((r) => setTimeout(r, 100));

        assert(observed.length >= 1, `expected ≥1 fire (got ${observed.length})`);
        const first = observed[0];
        assert(first.exists === false, `first fire should have exists()=false (got ${first.exists})`);
        assert(first.data === undefined, `first fire should have data()=undefined (got ${JSON.stringify(first.data)})`);
        say("initial fire on missing doc: exists=false, data=undefined");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      } finally {
        unsub?.();
      }
    })();
    return () => { unsub?.(); };
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
