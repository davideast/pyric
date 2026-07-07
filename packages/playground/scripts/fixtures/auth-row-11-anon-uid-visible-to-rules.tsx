/**
 * Pins matrix row Auth #11.
 *
 * Single claim: `signInAnonymously` writes through to the auth state
 * the rules engine consults, so a rule that gates on
 * `request.auth.uid == userId` admits a write to /users/{uid} for the
 * just-signed-in anonymous user. (Round-trip via setDoc → getDoc
 * proves the rule saw the uid.)
 */
import { useEffect, useState } from "react";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";

const NAME = "auth-row-11-anon-uid-visible-to-rules";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "users", a.user.uid);
        await setDoc(ref, { uid: a.user.uid });
        const snap = await getDoc(ref);
        const data = snap.data() as { uid: string } | undefined;
        assert(data?.uid === a.user.uid, `rules-gated write should land (got ${String(data?.uid)})`);
        say("anonymous uid was visible to the rules engine");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
