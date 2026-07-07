/**
 * Pins matrix row Firestore #17.
 *
 * Single claim: `DocumentSnapshot.exists` is normalized to **method**
 * form (`snap.exists()` returns boolean) to match the modular SDK.
 * Sandbox callers can rely on calling `snap.exists()`.
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-row-17-snap-exists-method";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "notes", a.user.uid);

        // Missing doc: exists() should be callable AND return false.
        const missing = await getDoc(ref);
        assert(typeof missing.exists === "function", "snap.exists should be a function (got " + typeof missing.exists + ")");
        const missingBool = (missing.exists as () => boolean)();
        assert(missingBool === false, `missing doc exists() should be false (got ${missingBool})`);

        // Existing doc: exists() should be callable AND return true.
        await setDoc(ref, { v: 1 });
        const present = await getDoc(ref);
        assert(typeof present.exists === "function", "snap.exists should be a function on existing doc too");
        const presentBool = (present.exists as () => boolean)();
        assert(presentBool === true, `present doc exists() should be true (got ${presentBool})`);

        say("snap.exists is method form on both missing and present docs");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
