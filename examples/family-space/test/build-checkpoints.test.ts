import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments } from "pyric/sandbox/firestore";
import * as sdk from "pyric/firestore";
import { createBuildRepository } from "../build-repository";
import { initialWorkflow } from "../build-workflow-types";
import type { GenerationSpec } from "../generation-types";
const spec: GenerationSpec = {
  id: "app",
  buildId: "build",
  ownerId: "daniel",
  draftRevision: 1,
  baseVersionId: null,
  title: "Test",
  prompt: "Test",
  context: "{}",
  audience: ["daniel"],
  createdAt: 1,
};
function setup() {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, {
    "families/parkers/apps/app": {
      ownerId: "daniel",
      deletedAt: null,
      activeVersionId: null,
    },
    "families/parkers/apps/app/drafts/main": {
      revision: 1,
      latestBuildId: "build",
    },
    "families/parkers/apps/app/builds/build": { state: "running" },
  });
  const db = sdk.getFirestore(sandbox);
  let time = 1000,
    user: string | null = "daniel";
  const repo = createBuildRepository({
    db,
    api: {
      ...sdk,
      runTransaction: (
        db: Parameters<typeof sdk.runTransaction>[0],
        fn: (tx: unknown) => unknown,
      ) =>
        sdk.runTransaction(db, (tx) =>
          fn({
            ...tx,
            get: async (ref: Parameters<typeof tx.get>[0]) => {
              const snap = await tx.get(ref);
              return {
                ...snap,
                exists: () => snap.exists(),
                data: () => snap.data(),
              };
            },
            set: tx.set.bind(tx),
            update: tx.update.bind(tx),
          }),
        ),
    },
    base: "families/parkers",
    uid: () => user,
    now: () => time,
  });
  return {
    repo,
    db,
    setTime: (n: number) => (time = n),
    setUser: (s: string | null) => (user = s),
  };
}
test("a committed workspace can be restored by a new executor without repeating completed work", async () => {
  const { repo } = setup();
  const lease = await repo.acquire(spec, "worker-one");
  const state = initialWorkflow(spec);
  state.files["/work/App.tsx"] =
    "export default function App(){return <h1>Hello</h1>}";
  state.stage = "compile";
  const saved = await repo.commit(spec, lease, 0, state);
  const restored = await repo.restore(spec);
  expect(restored?.state.stage).toBe("compile");
  expect(restored?.state.files["/work/App.tsx"]).toContain("<h1>Hello</h1>");
  expect(restored?.revision).toBe(saved.revision);
  await expect(repo.acquire(spec, "worker-two")).rejects.toThrow("another");
});
test("release fences the old executor and checkpoint writes remain idempotent", async () => {
  const { repo } = setup(),
    lease = await repo.acquire(spec, "first"),
    state = initialWorkflow(spec);
  const first = await repo.commit(spec, lease, 0, state);
  expect(await repo.commit(spec, lease, 0, state)).toEqual(first);
  await repo.release(spec, lease, "interrupted");
  const next = await repo.acquire(spec, "second");
  state.stage = "code";
  await expect(repo.commit(spec, lease, first.revision, state)).rejects.toThrow(
    "lease",
  );
  await repo.commit(spec, next, first.revision, state);
  expect((await repo.restore(spec))?.state.stage).toBe("code");
});
test("large Unicode workspace files round trip without splitting a Firestore document limit", async () => {
  const { repo } = setup(),
    lease = await repo.acquire(spec, "first"),
    state = initialWorkflow(spec);
  state.files["/work/context.json"] = "🌻".repeat(150000);
  await repo.commit(spec, lease, 0, state);
  expect((await repo.restore(spec))?.state.files["/work/context.json"]).toBe(
    "🌻".repeat(150000),
  );
});
test("expired leases cannot commit and a new executor can acquire", async () => {
  const { repo, setTime } = setup(),
    lease = await repo.acquire(spec, "first");
  setTime(61001);
  await expect(
    repo.commit(spec, lease, 0, initialWorkflow(spec)),
  ).rejects.toThrow("lease");
  const next = await repo.acquire(spec, "second");
  await repo.commit(spec, next, 0, initialWorkflow(spec));
  expect((await repo.restore(spec))?.revision).toBe(1);
});
test("a missing artifact cannot be restored as a valid workspace", async () => {
  const { repo, db } = setup(),
    lease = await repo.acquire(spec, "first");
  const saved = await repo.commit(spec, lease, 0, initialWorkflow(spec));
  await sdk.deleteDoc(
    sdk.doc(
      db,
      `families/parkers/apps/app/builds/build/checkpoints/${saved.checkpointId}/artifacts/0`,
    ),
  );
  await expect(repo.restore(spec)).rejects.toThrow("missing or corrupt");
});
test("sign out and draft edits reject pending checkpoint commits", async () => {
  const { repo, db, setUser } = setup(),
    lease = await repo.acquire(spec, "first");
  setUser(null);
  await expect(
    repo.commit(spec, lease, 0, initialWorkflow(spec)),
  ).rejects.toThrow("identity");
  setUser("daniel");
  await sdk.updateDoc(sdk.doc(db, "families/parkers/apps/app/drafts/main"), {
    revision: 2,
  });
  await expect(
    repo.commit(spec, lease, 0, initialWorkflow(spec)),
  ).rejects.toThrow("draft changed");
});
test("changing the active version rejects a stale build", async () => {
  const { repo, db } = setup();
  const input = { ...spec, expectedActiveVersionId: null };
  const lease = await repo.acquire(input, "first");
  await sdk.updateDoc(sdk.doc(db, "families/parkers/apps/app"), {
    activeVersionId: "newer",
  });
  await expect(
    repo.commit(input, lease, 0, initialWorkflow(input)),
  ).rejects.toThrow("active version changed");
});
import { readFileSync } from "node:fs";
import { setRules } from "pyric/sandbox/firestore";
test("checkpoint artifacts are immutable and readable only by their owning parent", async () => {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, {
    "families/parkers/members/daniel": { role: "parent" },
    "families/parkers/members/alex": { role: "parent" },
    "families/parkers/members/sam": { role: "kid" },
    "families/parkers/apps/app": { ownerId: "daniel", deletedAt: null },
  });
  setRules(
    sandbox,
    readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
  );
  const path = "families/parkers/apps/app/builds/b/checkpoints/c/artifacts/0";
  const owner = sdk.getFirestore(sandbox.withAuth({ uid: "daniel" }));
  await sdk.setDoc(sdk.doc(owner, path), {
    content: "private snapshot",
    hash: "test",
  });
  expect((await sdk.getDoc(sdk.doc(owner, path))).data()?.content).toBe(
    "private snapshot",
  );
  await expect(
    sdk.updateDoc(sdk.doc(owner, path), { content: "changed" }),
  ).rejects.toThrow();
  for (const auth of [
    { uid: "alex" },
    { uid: "sam" },
    { uid: "outsider" },
    null,
  ]) {
    const db = sdk.getFirestore(sandbox.withAuth(auth));
    await expect(sdk.getDoc(sdk.doc(db, path))).rejects.toThrow();
  }
});
test("releasing an executor never promotes an uncommitted result to ready", async () => {
  const { repo } = setup(),
    lease = await repo.acquire(spec, "worker");
  await repo.commit(spec, lease, 0, initialWorkflow(spec));
  await repo.release(spec, lease, "ready");
  expect((await repo.restore(spec))?.state.status).toBe("running");
});
