/**
 * Pins matrix row Auth #15.
 *
 * Single claim: `signInWithEmailAndPassword` rejects with
 * `code: 'auth/wrong-password'` when the password doesn't match.
 * Oracle-confirmed against firebase-js-sdk 12.13.0:
 * scripts/oracle/observations/auth-wrong-password-error-code.json.
 */
import { useEffect, useState } from "react";
import {
  getAuth, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from "firebase/auth";

const NAME = "auth-row-15-wrong-password-rejects";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();
        await createUserWithEmailAndPassword(auth, "row15@example.com", "right");
        await signOut(auth);

        let code: string | null = null;
        try {
          await signInWithEmailAndPassword(auth, "row15@example.com", "wrong");
        } catch (e) {
          code = (e as { code?: string }).code ?? null;
        }
        assert(code === "auth/wrong-password",
          `expected code 'auth/wrong-password', got ${String(code)}`);
        say("wrong password rejected with auth/wrong-password");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
