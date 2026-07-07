/**
 * Pins matrix row Auth #10.
 *
 * Single claim: `onAuthStateChanged` fires exactly once per identity
 * transition (no same-value double-fire). The canonical sequence:
 * `signInAnonymously` → `signOut` → `signInAnonymously` produces
 * exactly three observed identity states.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-row-10-onauthstatechanged-one-per-transition";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    const auth = getAuth();
    const fires: Array<string> = [];
    const unsub = onAuthStateChanged(auth, (u) => fires.push(u ? u.uid : "null"));

    void (async () => {
      try {
        const a = await signInAnonymously(auth);
        await signOut(auth);
        const b = await signInAnonymously(auth);
        await new Promise((r) => setTimeout(r, 50));

        // Expected exactly 3 fires: anon-1, null, anon-2.
        // The initial-null subscribe-replay is suppressed by the
        // dedup path because signInAnonymously fires the same observer
        // synchronously before the microtask gets to run.
        assert(
          fires.length === 3,
          `expected exactly 3 listener fires, got ${fires.length}: [${fires.join(",")}]`,
        );
        assert(fires[0] === a.user.uid, `fire[0] should be ${a.user.uid} (got ${fires[0]})`);
        assert(fires[1] === "null", `fire[1] should be 'null' (got ${fires[1]})`);
        assert(fires[2] === b.user.uid, `fire[2] should be ${b.user.uid} (got ${fires[2]})`);
        say(`3 fires, one per transition: ${fires.join(" → ")}`);
        unsub();
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { unsub(); };
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
