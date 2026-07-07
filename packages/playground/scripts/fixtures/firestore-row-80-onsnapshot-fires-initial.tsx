/**
 * Pins matrix row Firestore #80.
 *
 * Single claim: `onSnapshot(docRef, cb)` fires the initial snapshot
 * (microtask-deferred). After subscribing, the listener callback
 * receives at least one fire without any explicit write happening.
 */
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-80-onsnapshot-fires-initial";

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

        let fires = 0;
        unsub = onSnapshot(ref, () => { fires += 1; });

        // Give the microtask + any deferred dispatch time to run.
        await new Promise((r) => setTimeout(r, 100));

        assert(fires >= 1, `expected at least 1 initial fire (got ${fires})`);
        say(`initial fire delivered (${fires} fire(s))`);
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
