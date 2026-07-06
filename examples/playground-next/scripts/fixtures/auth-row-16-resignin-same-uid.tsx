/**
 * Pins matrix row Auth #16.
 *
 * Single claim: signing back in via `signInWithEmailAndPassword`
 * after a `signOut` returns the **same** uid (the password account
 * persists for the sandbox lifetime).
 */
import { useEffect, useState } from "react";
import {
  getAuth, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from "firebase/auth";

const NAME = "auth-row-16-resignin-same-uid";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        const created = await createUserWithEmailAndPassword(auth, "row16@example.com", "p@ss");
        const originalUid = created.user.uid;
        await signOut(auth);
        const reSigned = await signInWithEmailAndPassword(auth, "row16@example.com", "p@ss");
        assert(
          reSigned.user.uid === originalUid,
          `re-signed uid should equal original ${originalUid} (got ${reSigned.user.uid})`,
        );
        say(`uid persisted across signOut+signIn cycle: ${originalUid}`);
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
