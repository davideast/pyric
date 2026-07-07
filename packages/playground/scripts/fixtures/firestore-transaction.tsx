/**
 * firestore-transaction: runTransaction reads a counter, increments
 * it inside the transaction, writes back. Verifies the transaction
 * surface compiles + runs + commits.
 */
import { useEffect, useState } from "react";
import { doc, runTransaction, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-transaction";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "counters", a.user.uid);
        await setDoc(ref, { count: 10 });

        const result = await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          const exists = typeof snap.exists === "function" ? (snap.exists as () => boolean)() : snap.exists;
          assert(exists, "counter doc should exist");
          const current = (snap.data() as { count: number }).count;
          tx.update(ref, { count: current + 5 });
          return current + 5;
        });

        assert(result === 15, `transaction return should be 15 (got ${result})`);
        say(`transaction returned ${result}`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
