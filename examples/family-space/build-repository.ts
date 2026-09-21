import { contentHash, chunks } from "./build-artifacts";
import * as firebase from "firebase/firestore";
import type { GenerationSpec } from "./generation-types";
import type {
  WorkflowState,
  BuildLease,
  RestoredBuild,
} from "./build-workflow-types";
const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
export function createBuildRepository(options: {
  db: unknown;
  api?: unknown;
  base: string;
  uid: () => string | null;
  now?: () => number;
}) {
  // Firebase and Pyric expose the same public SDK operations; injection enables sandbox integration tests.
  const api = (options.api ?? firebase) as typeof firebase,
    db = options.db as firebase.Firestore,
    now = options.now ?? Date.now;
  const app = (s: GenerationSpec) =>
    api.doc(db, `${options.base}/apps/${s.id}`);
  const draft = (s: GenerationSpec) =>
    api.doc(db, `${options.base}/apps/${s.id}/drafts/main`);
  const build = (s: GenerationSpec) =>
    api.doc(db, `${options.base}/apps/${s.id}/builds/${s.buildId}`);
  function identity(s: GenerationSpec) {
    if (!s.buildId || options.uid() !== s.ownerId)
      throw Error("Build identity is no longer available.");
  }
  async function current(tx: firebase.Transaction, s: GenerationSpec) {
    identity(s);
    const a = await tx.get(app(s)),
      d = await tx.get(draft(s)),
      b = await tx.get(build(s));
    if (!a.exists() || a.data().deletedAt || a.data().ownerId !== s.ownerId)
      throw Error("App is unavailable.");
    if (
      !d.exists() ||
      d.data().revision !== s.draftRevision ||
      d.data().latestBuildId !== s.buildId
    )
      throw Error(
        "The draft changed. Start a new build from the current draft.",
      );
    // baseVersionId may identify an unactivated candidate. Capture the active projection separately.
    if (
      s.expectedActiveVersionId !== undefined &&
      (a.data().activeVersionId ?? null) !== s.expectedActiveVersionId
    )
      throw Error(
        "The active version changed. Start a new build from the current draft.",
      );
    if (!b.exists()) throw Error("Build is unavailable.");
    return b.data();
  }
  function fence(data: firebase.DocumentData, l: BuildLease) {
    if (
      data.lease?.token !== l.token ||
      data.lease?.executor !== l.executor ||
      data.lease.expiresAt <= now()
    )
      throw Error("Build lease was lost to another executor or expired.");
  }
  return {
    async acquire(s: GenerationSpec, executor: string): Promise<BuildLease> {
      return api.runTransaction(db, async (tx) => {
        const data = await current(tx, s);
        if (data.lease?.expiresAt > now())
          throw Error("This build is running in another tab or device.");
        const lease = {
          executor,
          token: crypto.randomUUID(),
          expiresAt: now() + 60000,
        };
        tx.update(build(s), { lease });
        return lease;
      });
    },
    async renew(s: GenerationSpec, l: BuildLease) {
      await api.runTransaction(db, async (tx) => {
        const data = await current(tx, s);
        fence(data, l);
        tx.update(build(s), { lease: { ...l, expiresAt: now() + 60000 } });
      });
    },
    async release(
      s: GenerationSpec,
      l: BuildLease,
      status?: WorkflowState["status"],
    ) {
      identity(s);
      await api.runTransaction(db, async (tx) => {
        const b = await tx.get(build(s));
        if (b.data()?.lease?.token === l.token) {
          const update: firebase.DocumentData = { lease: null };
          if (
            (status === "interrupted" || status === "cancelled") &&
            b.data()?.state !== "ready"
          )
            update.state = status;
          tx.update(build(s), update);
        }
      });
    },
    async commit(
      s: GenerationSpec,
      l: BuildLease,
      revision: number,
      state: WorkflowState,
    ): Promise<{ revision: number; checkpointId: string }> {
      identity(s);
      const payload = JSON.stringify(clean(state)),
        parts = chunks(payload);
      const hashes = await Promise.all(parts.map(contentHash));
      const manifest = {
        format: 1,
        revision: revision + 1,
        hash: await contentHash(payload),
        chunks: hashes,
      };
      const checkpointId = await contentHash(JSON.stringify(manifest));
      const path = `${build(s).path}/checkpoints/${checkpointId}`;
      const ref = api.doc(db, path),
        prior = await api.getDoc(ref);
      if (!prior.exists()) await api.setDoc(ref, manifest);
      // Enumerate incomplete uploads through their manifest; only the pointer commits them.
      // Immutable, retryable uploads. A checkpoint is not visible until the fenced pointer commit.
      for (let i = 0; i < parts.length; i++) {
        identity(s);
        const ref = api.doc(db, `${path}/artifacts/${i}`),
          prior = await api.getDoc(ref);
        if (!prior.exists())
          await api.setDoc(ref, { content: parts[i], hash: hashes[i] });
        else if (prior.data().hash !== hashes[i])
          throw Error("Checkpoint artifact conflict.");
      }
      await api.runTransaction(db, async (tx) => {
        const data = await current(tx, s);
        fence(data, l);
        if (
          data.checkpointId === checkpointId &&
          data.revision === revision + 1
        )
          return;
        if ((data.revision ?? 0) !== revision)
          throw Error("Build checkpoint revision changed.");
        tx.update(build(s), {
          checkpointId,
          revision: revision + 1,
          workflowFormat: 1,
          stage: state.stage,
          state: state.status,
          error: state.diagnostic ?? null,
          updatedAt: now(),
        });
      });
      return { revision: revision + 1, checkpointId };
    },
    async restore(s: GenerationSpec): Promise<RestoredBuild | null> {
      identity(s);
      const b = await api.getDoc(build(s)),
        data = b.data();
      if (!data?.checkpointId) return null;
      const path = `${build(s).path}/checkpoints/${data.checkpointId}`,
        m = (await api.getDoc(api.doc(db, path))).data();
      if (
        !m ||
        m.format !== 1 ||
        !Array.isArray(m.chunks) ||
        m.chunks.length > 1000
      )
        throw Error("Checkpoint manifest is missing or invalid.");
      const { format, revision, hash, chunks: hashes } = m;
      if (
        (await contentHash(
          JSON.stringify({ format, revision, hash, chunks: hashes }),
        )) !== data.checkpointId
      )
        throw Error("Checkpoint manifest hash mismatch.");
      let payload = "";
      for (let i = 0; i < hashes.length; i++) {
        const part = (
          await api.getDoc(api.doc(db, `${path}/artifacts/${i}`))
        ).data();
        if (
          typeof part?.content !== "string" ||
          (await contentHash(part.content)) !== hashes[i]
        )
          throw Error("Checkpoint artifact is missing or corrupt.");
        payload += part.content;
      }
      if ((await contentHash(payload)) !== hash)
        throw Error("Checkpoint content hash mismatch.");
      const state = JSON.parse(payload) as WorkflowState;
      if (
        state.format !== 1 ||
        state.spec.ownerId !== s.ownerId ||
        state.spec.id !== s.id ||
        state.spec.buildId !== s.buildId
      )
        throw Error("Checkpoint identity or format mismatch.");
      state.status = data.state;
      identity(s);
      return {
        state,
        revision: data.revision,
        checkpointId: data.checkpointId,
      };
    },
    async discover() {
      const uid = options.uid();
      if (!uid) return [];
      const apps = await api.getDocs(
        api.query(
          api.collection(db, options.base + "/apps"),
          api.where("ownerId", "==", uid),
        ),
      );
      const found: Array<{
        appId: string;
        buildId: string;
        state: string;
        lease?: BuildLease;
        updatedAt: number;
      }> = [];
      for (const a of apps.docs) {
        if (a.data().deletedAt) continue;
        const builds = await api.getDocs(
          api.collection(db, `${a.ref.path}/builds`),
        );
        for (const b of builds.docs) {
          const d = b.data();
          if (
            d.workflowFormat === 1 &&
            d.state !== "ready" &&
            d.state !== "cancelled"
          )
            found.push({
              appId: a.id,
              buildId: b.id,
              state: d.state,
              lease: d.lease,
              updatedAt: d.updatedAt ?? 0,
            });
        }
      }
      return found.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}
