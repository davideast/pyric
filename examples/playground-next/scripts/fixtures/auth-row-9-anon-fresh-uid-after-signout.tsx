/**
 * Pins matrix row Auth #9.
 *
 * Single claim: after `signOut`, a subsequent `signInAnonymously`
 * mints a fresh uid (the prior anonymous identity is gone).
 */
import { useEffect, useState } from "react";
import { getAuth, signInAnonymously, signOut } from "firebase/auth";

const NAME = "auth-row-9-anon-fresh-uid-after-signout";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        const a = await signInAnonymously(auth);
        const firstUid = a.user.uid;
        await signOut(auth);
        const b = await signInAnonymously(auth);
        assert(
          b.user.uid !== firstUid,
          `second anon sign-in after signOut should mint a fresh uid (both were ${firstUid})`,
        );
        say(`uid before=${firstUid} after=${b.user.uid} — distinct`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
