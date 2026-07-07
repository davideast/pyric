/**
 * auth-listener-unsub: an explicitly-unsubscribed listener must not
 * fire on subsequent state changes. This is the precondition the
 * "no observer leak across re-mounts" guarantee depends on.
 */
import { useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-listener-unsub";

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
        // Microtask boundary so subscribe-replay (if any) has run.
        await Promise.resolve();
        const firesBeforeUnsub = fires.length;
        say(`fires before unsub: ${firesBeforeUnsub}`);

        unsub();
        await signOut(auth);
        await signInAnonymously(auth);
        await new Promise((r) => setTimeout(r, 50));

        assert(
          fires.length === firesBeforeUnsub,
          `post-unsub fires should not increase (was ${firesBeforeUnsub}, now ${fires.length}: ${fires.join(",")})`,
        );
        say("no fires after unsub — good");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
