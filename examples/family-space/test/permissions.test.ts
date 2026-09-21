import "fake-indexeddb/auto";
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from "pyric/firestore";
import { getStorageSandbox, ref, uploadBytes, getBytes } from "pyric/storage";
const seed = JSON.parse(
  readFileSync(new URL("../seed.json", import.meta.url), "utf8"),
);
const rules = readFileSync(
  new URL("../firestore.rules", import.meta.url),
  "utf8",
);
const storageRules = readFileSync(
  new URL("../storage.rules", import.meta.url),
  "utf8",
);
const base = "families/parkers";
function setup() {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, seed.firestore.firestore);
  setRules(sandbox, rules);
  const db = (uid: string | null) =>
    getFirestore(sandbox.withAuth(uid ? { uid } : null));
  return { sandbox, db };
}
const draft = {
  authorId: "sam",
  title: "A little family news",
  body: "We won our match!",
  kind: "article",
  status: "pending",
  audience: ["family"],
  createdAt: 1,
  mediaPath: "",
  cover: "",
  url: "",
  eventAt: "",
  location: "",
};
describe("family permissions", () => {
  it("blocks signed-out and other-family users, including role escalation", async () => {
    const { db } = setup();
    for (const uid of [null, "outsider"])
      await expect(
        getDoc(doc(db(uid), `${base}/posts/weekend`)),
      ).rejects.toThrow();
    await expect(
      updateDoc(doc(db("sam"), `${base}/members/sam`), { role: "parent" }),
    ).rejects.toThrow();
  });
  it("requires parent approval and reapproval of edited kid posts", async () => {
    const { db } = setup();
    await setDoc(doc(db("sam"), `${base}/posts/new`), draft);
    await expect(getDoc(doc(db("zoe"), `${base}/posts/new`))).rejects.toThrow();
    await expect(
      updateDoc(doc(db("sam"), `${base}/posts/new`), { status: "published" }),
    ).rejects.toThrow();
    await updateDoc(doc(db("emma"), `${base}/posts/new`), {
      status: "published",
    });
    expect(
      (await getDoc(doc(db("zoe"), `${base}/posts/new`))).data()?.title,
    ).toBe(draft.title);
    await expect(
      updateDoc(doc(db("sam"), `${base}/posts/new`), { title: "Changed" }),
    ).rejects.toThrow();
    await updateDoc(doc(db("sam"), `${base}/posts/new`), {
      title: "Changed",
      status: "pending",
    });
    await expect(getDoc(doc(db("zoe"), `${base}/posts/new`))).rejects.toThrow();
  });
  it("protects personalized feeds and lets kids query only visible or owned posts", async () => {
    const { db } = setup();
    expect(
      (await getDoc(doc(db("sam"), `${base}/posts/sam-reading`))).exists(),
    ).toBe(true);
    await expect(
      getDoc(doc(db("zoe"), `${base}/posts/sam-reading`)),
    ).rejects.toThrow();
    await expect(
      updateDoc(doc(db("sam"), `${base}/posts/zoe-dance`), {
        body: "Changed",
        status: "pending",
      }),
    ).rejects.toThrow();
    await expect(
      getDocs(collection(db("sam"), `${base}/posts`)),
    ).rejects.toThrow();
    const published = await getDocs(
      query(
        collection(db("sam"), `${base}/posts`),
        where("status", "==", "published"),
        where("audience", "array-contains", "sam"),
      ),
    );
    expect(published.docs.map((d) => d.id)).toContain("sam-reading");
    expect(published.docs.map((d) => d.id)).not.toContain("zoe-dance");
    const family = await getDocs(
      query(
        collection(db("sam"), `${base}/posts`),
        where("status", "==", "published"),
        where("audience", "array-contains", "family"),
      ),
    );
    expect(family.docs.map((d) => d.id)).toContain("weekend");
    const own = await getDocs(
      query(
        collection(db("sam"), `${base}/posts`),
        where("authorId", "==", "sam"),
      ),
    );
    expect(own.docs.map((d) => d.id)).toContain("dog");
  });
  it("keeps comment and chat authorship immutable", async () => {
    const { db } = setup();
    const path = `${base}/posts/weekend/comments/new`;
    await setDoc(doc(db("sam"), path), {
      authorId: "sam",
      text: "Hello",
      createdAt: 1,
    });
    await expect(
      updateDoc(doc(db("zoe"), path), { text: "Changed" }),
    ).rejects.toThrow();
    await expect(
      updateDoc(doc(db("sam"), path), { authorId: "emma" }),
    ).rejects.toThrow();
    await updateDoc(doc(db("sam"), path), { text: "Hello family" });
    await deleteDoc(doc(db("emma"), path));
    const chat = `${base}/chat/new`;
    await setDoc(doc(db("sam"), chat), {
      authorId: "sam",
      text: "Hi",
      createdAt: 1,
      mediaPath: "",
      mediaType: "",
    });
    await expect(deleteDoc(doc(db("zoe"), chat))).rejects.toThrow();
    await expect(
      setDoc(doc(db("sam"), `${base}/chat/forged`), {
        authorId: "emma",
        text: "Fake",
        createdAt: 1,
        mediaPath: "",
        mediaType: "",
      }),
    ).rejects.toThrow();
  });
  it("records a kid view that parents can inspect without allowing forged viewers", async () => {
    const { db } = setup();
    await setDoc(doc(db("sam"), `${base}/posts/weekend/views/sam`), {
      viewedAt: serverTimestamp(),
    });
    expect(
      (
        await getDoc(doc(db("emma"), `${base}/posts/weekend/views/sam`))
      ).exists(),
    ).toBe(true);
    expect(
      (
        await getDocs(collection(db("emma"), `${base}/posts/weekend/views`))
      ).docs.map((d) => d.id),
    ).toEqual(["sam"]);
    await expect(
      setDoc(doc(db("sam"), `${base}/posts/weekend/views/zoe`), {
        viewedAt: serverTimestamp(),
      }),
    ).rejects.toThrow();
    await expect(
      setDoc(doc(db("zoe"), `${base}/posts/sam-reading/views/zoe`), {
        viewedAt: serverTimestamp(),
      }),
    ).rejects.toThrow();
  });
  it("guards attachments by family, audience, and approval status", async () => {
    const { sandbox, db } = setup();
    const dbName = `kin-media-${crypto.randomUUID()}`;
    const storage = (uid: string) =>
      getStorageSandbox(sandbox.withAuth({ uid }), {
        rules: storageRules,
        dbName,
      });
    const path = `${base}/posts/sam-reading/photo.png`;
    await uploadBytes(ref(storage("emma"), path), new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
    });
    expect((await getBytes(ref(storage("sam"), path))).byteLength).toBe(3);
    await expect(getBytes(ref(storage("zoe"), path))).rejects.toThrow();
    await expect(getBytes(ref(storage("outsider"), path))).rejects.toThrow();
    await setDoc(doc(db("sam"), `${base}/posts/new`), draft);
    const own = `${base}/posts/new/photo.png`;
    await uploadBytes(ref(storage("sam"), own), new Uint8Array([1]), {
      contentType: "image/png",
    });
    await updateDoc(doc(db("emma"), `${base}/posts/new`), {
      status: "published",
    });
    await expect(
      uploadBytes(ref(storage("sam"), own), new Uint8Array([2]), {
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });
});

describe("generated family apps", () => {
  const appData = {
    ownerId: "emma",
    title: "Chores",
    prompt: "Make chores",
    source: "export default function App(){}",
    context: "{}",
    audience: ["emma", "sam"],
    createdAt: 1,
    published: false,
  };
  it("lets parents create drafts, share with selected users, and revoke access", async () => {
    const { db } = setup(),
      path = base + "/apps/chores";
    await expect(
      setDoc(doc(db("sam"), path), { ...appData, ownerId: "sam" }),
    ).rejects.toThrow();
    await setDoc(doc(db("emma"), path), appData);
    await expect(getDoc(doc(db("sam"), path))).rejects.toThrow();
    await updateDoc(doc(db("emma"), path), {
      source: "export default function App(){return null}",
    });
    await expect(
      updateDoc(doc(db("sam"), path), { source: "changed" }),
    ).rejects.toThrow();
    await expect(
      updateDoc(doc(db("daniel"), path), { source: "changed" }),
    ).rejects.toThrow();
    await updateDoc(doc(db("emma"), path), { published: true });
    expect((await getDoc(doc(db("sam"), path))).exists()).toBe(true);
    await expect(getDoc(doc(db("zoe"), path))).rejects.toThrow();
    await expect(
      updateDoc(doc(db("sam"), path), { audience: ["sam", "zoe"] }),
    ).rejects.toThrow();
    await expect(
      updateDoc(doc(db("emma"), path), { audience: ["emma", "sam", "zoe"] }),
    ).rejects.toThrow();
    expect(
      (
        await getDocs(
          query(
            collection(db("sam"), base + "/apps"),
            where("published", "==", true),
            where("audience", "array-contains", "sam"),
          ),
        )
      ).size,
    ).toBe(1);
    await updateDoc(doc(db("emma"), path), { published: false });
    await expect(getDoc(doc(db("sam"), path))).rejects.toThrow();
  });
  it("allows high-trust family record editing but denies outsiders and signed-out users", async () => {
    const { db } = setup(),
      path = base + "/apps/chores/records/task";
    await setDoc(doc(db("emma"), path), { text: "Dishes", done: false });
    await updateDoc(doc(db("sam"), path), { done: true });
    expect((await getDoc(doc(db("zoe"), path))).data()?.done).toBe(true);
    for (const uid of [null, "outsider"]) {
      await expect(getDoc(doc(db(uid), path))).rejects.toThrow();
      await expect(
        setDoc(doc(db(uid), path), { done: false }),
      ).rejects.toThrow();
    }
    await deleteDoc(doc(db("daniel"), path));
  });
});

describe("UI kit", () => {
  it("lets parents read immutable source and denies kids and outsiders", async () => {
    const { db } = setup();
    const path = base + "/uiKits/kin-v1/entries/button";
    expect((await getDoc(doc(db("emma"), path))).exists()).toBe(true);
    expect(
      (await getDocs(collection(db("daniel"), base + "/uiKits/kin-v1/entries")))
        .size,
    ).toBe(7);
    for (const uid of ["sam", "outsider", null])
      await expect(getDoc(doc(db(uid), path))).rejects.toThrow();
    await expect(
      updateDoc(doc(db("emma"), path), { source: "changed" }),
    ).rejects.toThrow();
    await expect(deleteDoc(doc(db("emma"), path))).rejects.toThrow();
  });
});

describe("shipped app templates", () => {
  it("allows family reads, parent installs, and no client mutations of installed templates", async () => {
    const { db } = setup();
    const path = `${base}/appTemplates/dinner-spinner`;
    const template = (await getDoc(doc(db("emma"), path))).data()!;
    expect((await getDoc(doc(db("sam"), path))).exists()).toBe(true);
    for (const uid of [null, "outsider"])
      await expect(getDoc(doc(db(uid), path))).rejects.toThrow();
    await expect(
      setDoc(doc(db("sam"), `${base}/appTemplates/kid-copy`), template),
    ).rejects.toThrow();
    await setDoc(doc(db("emma"), `${base}/appTemplates/parent-copy`), template);
    await expect(
      updateDoc(doc(db("emma"), path), { title: "Changed" }),
    ).rejects.toThrow();
    await expect(deleteDoc(doc(db("emma"), path))).rejects.toThrow();
  });
});

describe("app version lifecycle", () => {
  it("keeps version history immutable and owner-only while sharing only the active app", async () => {
    const { db } = setup();
    const app = `${base}/apps/version-test`;
    await setDoc(doc(db("emma"), app), {
      ownerId: "emma",
      title: "Counter",
      prompt: "Counter",
      source: "old",
      context: "{}",
      audience: ["emma", "sam"],
      createdAt: 1,
      published: false,
    });
    const path = app + "/versions/v1";
    await setDoc(doc(db("emma"), path), {
      number: 1,
      baseVersionId: null,
      buildId: "b1",
      prompt: "Counter",
      model: "test",
      sourceHash: "hash",
      dataSchemaVersion: 1,
      createdAt: 1,
      title: "Counter",
      audience: ["emma"],
    });
    expect((await getDoc(doc(db("emma"), path))).data()?.number).toBe(1);
    await expect(
      updateDoc(doc(db("emma"), path), { prompt: "changed" }),
    ).rejects.toThrow();
    await expect(getDoc(doc(db("sam"), path))).rejects.toThrow();
    await expect(
      setDoc(doc(db("sam"), app + "/versions/forged"), { number: 2 }),
    ).rejects.toThrow();
  });
});

describe("app trash permissions", () => {
  it("prevents sharing or completing a build after deletion", async () => {
    const { db } = setup();
    const path = base + "/apps/deleted-app";
    await setDoc(doc(db("emma"), path), {
      ownerId: "emma",
      title: "Draft",
      prompt: "",
      source: "",
      context: "{}",
      audience: ["emma", "sam"],
      createdAt: 1,
      published: false,
      deletedAt: null,
    });
    await updateDoc(doc(db("emma"), path), { deletedAt: 2, published: false });
    await expect(
      updateDoc(doc(db("emma"), path), { published: true }),
    ).rejects.toThrow();
    await expect(
      setDoc(doc(db("emma"), path + "/builds/late"), { state: "ready" }),
    ).rejects.toThrow();
    await expect(getDoc(doc(db("sam"), path))).rejects.toThrow();
  });
});
