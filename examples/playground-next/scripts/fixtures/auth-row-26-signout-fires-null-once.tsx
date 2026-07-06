/**
 * Pins matrix row Auth #26.
 *
 * Single claim: `signOut` fires `onAuthStateChanged` with `null`
 * exactly once. Setup: sign in (1 fire), wait for steady state,
 * record baseline, then signOut and verify exactly one new fire and
 * that the new fire is `null`.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-row-26-signout-fires-null-once";

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
        await signInAnonymously(auth);
        await new Promise((r) => setTimeout(r, 30));
        const baseline = fires.length;
        say(`baseline fires after sign-in: ${baseline}`);

        await signOut(auth);
        await new Promise((r) => setTimeout(r, 50));

        const newFires = fires.slice(baseline);
        assert(
          newFires.length === 1,
          `signOut should produce exactly 1 fire (got ${newFires.length}: [${newFires.join(",")}])`,
        );
        assert(newFires[0] === "null", `signOut fire should be 'null' (got ${newFires[0]})`);
        say("signOut fired listener once with null");
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
