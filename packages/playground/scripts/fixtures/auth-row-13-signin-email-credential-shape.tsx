/**
 * Pins matrix row Auth #13.
 *
 * Single claim: `signInWithEmailAndPassword` returns a `UserCredential`
 * with `operationType: 'signIn'` and a `User` carrying the stored uid +
 * email. (createUser is used purely to seed the account; this probe
 * focuses on signInWithEmailAndPassword's return shape.)
 */
import { useEffect, useState } from "react";
import {
  getAuth, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from "firebase/auth";

const NAME = "auth-row-13-signin-email-credential-shape";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        const created = await createUserWithEmailAndPassword(auth, "row13@example.com", "p@ss");
        const expectedUid = created.user.uid;
        await signOut(auth);

        const cred = await signInWithEmailAndPassword(auth, "row13@example.com", "p@ss");
        assert(cred.operationType === "signIn",
          `operationType should be 'signIn' (got ${String(cred.operationType)})`);
        assert(cred.user.uid === expectedUid,
          `signed-in uid should equal stored uid ${expectedUid} (got ${cred.user.uid})`);
        assert(cred.user.email === "row13@example.com",
          `email should be 'row13@example.com' (got ${String(cred.user.email)})`);
        say("password sign-in UserCredential shape matches spec");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
