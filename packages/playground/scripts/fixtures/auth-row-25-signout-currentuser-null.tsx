/**
 * Pins matrix row Auth #25.
 *
 * Single claim: `signOut(auth)` sets `auth.currentUser` to `null`
 * synchronously after resolution (no await on `currentUser` access).
 */
import { useEffect, useState } from "react";
import { getAuth, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-row-25-signout-currentuser-null";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        await signInAnonymously(auth);
        assert(auth.currentUser !== null, "currentUser should be set after sign-in");
        await signOut(auth);
        assert(auth.currentUser === null, "currentUser should be null synchronously after signOut resolves");
        say("currentUser === null right after signOut resolution");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
