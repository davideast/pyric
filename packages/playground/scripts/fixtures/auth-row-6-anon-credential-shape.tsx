/**
 * Pins matrix row Auth #6.
 *
 * Single claim: `signInAnonymously(auth)` returns a `UserCredential`
 * with `providerId: null`, `operationType: 'signIn'`, and a
 * `User` with `isAnonymous: true`, `email: null`, `displayName: null`.
 *
 * The providerId being `null` (not `'anonymous'`) was confirmed
 * empirically by the oracle harness against firebase-js-sdk 12.13.0:
 * packages/conformance/observations/auth/auth-anonymous-credential-providerid.json.
 */
import { useEffect, useState } from "react";
import { getAuth, signInAnonymously } from "firebase/auth";

const NAME = "auth-row-6-anon-credential-shape";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const cred = await signInAnonymously(getAuth());
        assert(cred.providerId === null,
          `providerId should be null (got ${String(cred.providerId)})`);
        assert(cred.operationType === "signIn",
          `operationType should be 'signIn' (got ${String(cred.operationType)})`);
        assert(cred.user.isAnonymous === true, "user.isAnonymous should be true");
        assert(cred.user.email === null, `user.email should be null (got ${String(cred.user.email)})`);
        assert(cred.user.displayName === null, `user.displayName should be null (got ${String(cred.user.displayName)})`);
        say("anonymous UserCredential shape matches spec");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
