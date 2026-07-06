/**
 * firestore-sentinels: serverTimestamp, increment, arrayUnion,
 * arrayRemove, deleteField. Verifies each sentinel survives a
 * write→read cycle with the expected shape.
 */
import { useEffect, useState } from "react";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp, increment, arrayUnion, arrayRemove, deleteField,
  Timestamp,
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { db } from "./firebase";

const NAME = "firestore-sentinels";

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => { setLog((l) => [...l, m]); console.log(`[${NAME}] ${m}`); };
  const done = (ok: boolean, why?: string) => console.log(`[${NAME}] DONE ${ok ? "ok" : "fail: " + why}`);
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  useEffect(() => {
    void (async () => {
      try {
        const a = await signInAnonymously(getAuth());
        const ref = doc(db, "stats", a.user.uid);

        await setDoc(ref, {
          createdAt: serverTimestamp(),
          count: 5,
          tags: ["a", "b"],
          obsolete: "removeme",
        });
        let snap = await getDoc(ref);
        const after = snap.data() as { createdAt: unknown; count: number; tags: string[]; obsolete: string };
        assert(after.createdAt instanceof Timestamp, "createdAt should be a Timestamp");
        assert(after.count === 5, "count seed");
        assert(JSON.stringify(after.tags) === JSON.stringify(["a", "b"]), "tags seed");

        await updateDoc(ref, {
          count: increment(3),
          tags: arrayUnion("c"),
          obsolete: deleteField(),
        });
        snap = await getDoc(ref);
        const post = snap.data() as { count: number; tags: string[]; obsolete?: string };
        assert(post.count === 8, `count should be 8 (got ${post.count})`);
        assert(post.tags.includes("c") && post.tags.length === 3, `tags should be [a,b,c] (got ${post.tags.join(",")})`);
        assert(post.obsolete === undefined, "obsolete should be deleted");

        await updateDoc(ref, { tags: arrayRemove("a") });
        snap = await getDoc(ref);
        const final = snap.data() as { tags: string[] };
        assert(!final.tags.includes("a"), `tags should not include 'a' (got ${final.tags.join(",")})`);
        say("all sentinels round-tripped");
        done(true);
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return <pre>{log.join("\n")}</pre>;
}
