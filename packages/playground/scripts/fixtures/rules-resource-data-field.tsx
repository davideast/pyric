/**
 * rules-resource-data-field: a write rule that reads the EXISTING
 * doc via `resource.data.<field>` must enforce ownership against the
 * stored author, not the incoming payload. Pins matrix row
 * Firestore #131.
 *
 * Scenario: /posts/{id} can be updated only by the author recorded
 * in the existing doc (`resource.data.author`). The incoming payload
 * cannot fake authorship after the fact.
 */
import { useEffect, useState } from "react";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import {
  getAuth, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword,
} from "firebase/auth";
import { db } from "./firebase";

const NAME = "rules-resource-data-field";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const auth = getAuth();

        // Create owner; createUser auto-signs them in.
        const owner = await createUserWithEmailAndPassword(auth, "owner@example.com", "p");
        const ownerUid = owner.user.uid;
        const ref = doc(db, "posts", "p1");
        await setDoc(ref, { author: ownerUid, body: "v1" });
        say(`owner ${ownerUid} created post`);

        // Owner updates — should succeed (resource.data.author == request.auth.uid).
        await updateDoc(ref, { body: "v2 by owner" });
        const afterOwner = await getDoc(ref);
        const ownerBody = (afterOwner.data() as { body: string }).body;
        assert(ownerBody === "v2 by owner", `owner update should land (got ${ownerBody})`);
        say("owner update succeeded");

        // Create intruder; createUser auto-signs them in, so we're now
        // a genuinely different uid.
        await signOut(auth);
        const intruder = await createUserWithEmailAndPassword(auth, "intruder@example.com", "p");
        const intruderUid = intruder.user.uid;
        assert(intruderUid !== ownerUid, "intruder should have a different uid");
        say(`switched to intruder ${intruderUid}`);

        // Intruder tries to update — `resource.data.author` is still
        // ownerUid, so the rule denies. Forging `author` in the payload
        // doesn't help; resource.data reads the STORED doc.
        let denied = false;
        try {
          await updateDoc(ref, { body: "hijacked", author: intruderUid });
        } catch { denied = true; }
        assert(denied, "intruder update should be denied via resource.data.author");
        say("intruder update correctly denied");

        // Post-deny sanity: stored author is unchanged.
        // Sign back in as owner so we can read (rule requires auth).
        await signOut(auth);
        await signInWithEmailAndPassword(auth, "owner@example.com", "p");
        const finalSnap = await getDoc(ref);
        const finalAuthor = (finalSnap.data() as { author: string }).author;
        assert(finalAuthor === ownerUid, `author should still be ${ownerUid} (got ${finalAuthor})`);
        say("stored doc is untouched");

        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
