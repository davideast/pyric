/**
 * Pins matrix row Auth #32.
 *
 * Single claim: the `Unsubscribe` returned by `onAuthStateChanged`
 * removes the observer — subsequent state changes do NOT fire it.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-row-32-unsubscribe-stops-fires";

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
        await Promise.resolve();
        const baseline = fires.length;
        say(`fires before unsub: ${baseline}`);

        unsub();
        await signOut(auth);
        await signInAnonymously(auth);
        await new Promise((r) => setTimeout(r, 50));

        assert(
          fires.length === baseline,
          `post-unsub fires should not increase (was ${baseline}, now ${fires.length}: [${fires.join(",")}])`,
        );
        say("no fires after unsub — observer removed");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
