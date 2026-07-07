/**
 * auth-signout-idempotent: signOut on an already-signed-out auth must
 * resolve without throwing AND must not fire onAuthStateChanged.
 * Pins matrix row Auth #27.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-signout-idempotent";

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
        await signOut(auth);
        await new Promise((r) => setTimeout(r, 30));
        const baseline = fires.length;
        say(`baseline fires after first signOut: ${baseline}`);

        // Second signOut against the now-already-signed-out state.
        // The contract: no throw, no listener fire.
        await signOut(auth);
        await new Promise((r) => setTimeout(r, 30));

        assert(auth.currentUser === null, "currentUser should still be null");
        assert(
          fires.length === baseline,
          `redundant signOut should not fire listener (baseline ${baseline}, now ${fires.length}: ${fires.join(",")})`,
        );
        say("redundant signOut was a quiet no-op");

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
