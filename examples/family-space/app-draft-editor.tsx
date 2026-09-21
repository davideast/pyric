import { diagnostic, diagnosticCode } from "./remote-diagnostics";
import { onSnapshot } from "firebase/firestore";
import { draftRef } from "./app-drafts";
import { trashApp, listVersions, readVersion } from "./app-versions";
import { AppBuildHistory } from "./app-build-history";
import React, { useEffect, useRef, useState } from "react";
import { readDraft, saveAppDraft, type AppDraft } from "./app-drafts";
import { dismissGeneration, startGeneration } from "./generation";
import type { FamilyApp } from "./generation-types";
import type { Member, Post } from "./data";
export function AppDraftEditor({
  id,
  app,
  member,
  members,
  posts,
  busy,
  onBack,
}: {
  id: string;
  app?: FamilyApp;
  member: Member;
  members: Member[];
  posts: Post[];
  busy: boolean;
  onBack: () => void;
}) {
  const key = `kin:draft:${member.id}:${id}`;
  const [value, setValue] = useState<AppDraft>({
    title: app?.title ?? "",
    prompt: app?.prompt ?? "",
    audience: app?.audience ?? [member.id],
    revision: 0,
    baseVersionId: app?.activeVersionId ?? null,
    status: "editing",
    latestBuildId: null,
    updatedAt: Date.now(),
  });
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false),
    [message, setMessage] = useState("Loading draft…"),
    [error, setError] = useState("");
  const revision = useRef(0),
    queue = useRef(Promise.resolve()),
    blocked = useRef(false),
    sequence = useRef(0),
    queued = useRef<{ tick: number; next: AppDraft } | null>(null),
    draining = useRef(false);
  useEffect(() => {
    let alive = true;
    diagnostic("draft-load-start");
    void readDraft(id)
      .then(async (saved) => {
        if (!alive) return;
        revision.current = saved?.revision ?? 0;
        let next = saved ?? value;
        if (!saved || saved.status === "ready") {
          const versionId = app?.activeVersionId ?? saved?.latestBuildId;
          if (versionId) {
            const version = (await listVersions(id)).find(
              (v) => v.id === versionId,
            );
            if (!alive) return;
            if (!version)
              throw new Error(
                "The selected version is unavailable. Reopen the app.",
              );
            next = {
              ...next,
              title: version.title,
              prompt: version.prompt,
              audience: version.audience,
              baseVersionId: version.id,
            };
          }
        }
        const journal = localStorage.getItem(key);
        if (journal) {
          const local = JSON.parse(journal);
          if (local.baseRevision === revision.current) next = local.value;
          else {
            next = local.value;
            blocked.current = true;
            setError(
              "A newer draft exists. Review your recovered text, then choose whether to save it over that draft.",
            );
          }
        }
        setValue(next);
        setLoaded(true);
        diagnostic("draft-load-end");
        setMessage(saved ? "Draft saved" : "Changes save automatically");
        if (journal && JSON.parse(journal).baseRevision === revision.current)
          save(next);
      })
      .catch((e) => {diagnostic("draft-load-failed",{code:diagnosticCode(e)});setError(String(e));});
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    if (!loaded) return;
    return onSnapshot(
      draftRef(id),
      (snapshot) => {
        if (snapshot.exists() && snapshot.data().revision === revision.current)
          setValue((v) => ({
            ...v,
            status: snapshot.data().status,
            latestBuildId: snapshot.data().latestBuildId,
          }));
      },
      (e) => setError(String(e)),
    );
  }, [id, loaded]);
  function save(next: AppDraft) {
    const tick = ++sequence.current;
    setValue(next);
    setMessage("Saving…");
    localStorage.setItem(
      key,
      JSON.stringify({ baseRevision: revision.current, value: next }),
    );
    queued.current = { tick, next };
    if (draining.current) return;
    draining.current = true;
    queue.current = queue.current.then(async () => {
      try {
        while (queued.current && !blocked.current) {
          const { tick, next } = queued.current;
          queued.current = null;
          diagnostic("draft-save-start");
          revision.current = await saveAppDraft(
            id,
            member.id,
            next,
            revision.current,
          );
          diagnostic("draft-save-end");
          if (tick === sequence.current) {
            localStorage.removeItem(key);
            setMessage("Draft saved");
          } else {
            const journal = localStorage.getItem(key);
            if (journal) {
              const pending = JSON.parse(journal);
              localStorage.setItem(
                key,
                JSON.stringify({ ...pending, baseRevision: revision.current }),
              );
            }
          }
        }
      } catch (e) {
        diagnostic("draft-save-failed",{code:diagnosticCode(e)});
        blocked.current = true;
        setError(String(e));
        setMessage("Saved on this device");
      } finally {
        draining.current = false;
      }
    });
  }
  function change(fields: Partial<AppDraft>) {
    save({ ...value, ...fields, status: "editing" });
  }
  async function generate() {
    if (pending) return;
    setPending(true);
    dismissGeneration();
    try {
      await queue.current;
      if (blocked.current) return;
      let baseSource = app?.source;
      if (value.baseVersionId) {
        const version = (await listVersions(id)).find(
          (v) => v.id === value.baseVersionId,
        );
        if (version) baseSource = (await readVersion(id, version)).source;
      }
      startGeneration({
        member,
        members,
        posts,
        title: value.title,
        prompt: value.prompt,
        audience: value.audience,
        appId: id,
        draftRevision: revision.current,
        baseVersionId: value.baseVersionId,
        baseSource,
      });
      location.hash = "build";
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="surface app-builder">
      <button className="back-link" onClick={onBack}>
        All apps
      </button>
      <h2>{app?.source ? "Edit app" : "A little app for your family"}</h2>
      <p role="status">{message}</p>
      {loaded && revision.current > 0 && (
        <button
          className="secondary"
          onClick={() => {
            if (window.confirm("Move this app and its draft to Trash?"))
              void queue.current
                .then(() => trashApp(id))
                .then(onBack)
                .catch((e) => setError(String(e)));
          }}
        >
          Delete app
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {blocked.current && loaded && (
        <button
          className="secondary"
          onClick={() => {
            blocked.current = false;
            setError("");
            void readDraft(id).then((saved) => {
              revision.current = saved?.revision ?? 0;
              save(value);
            });
          }}
        >
          Save recovered draft
        </button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void generate().catch((e) => setError(String(e)));
        }}
      >
        <fieldset
          disabled={!loaded || busy || pending || blocked.current}
          style={{ border: 0, padding: 0, display: "grid", gap: 20 }}
        >
          <label htmlFor="draft-title">App name</label>
          <input
            id="draft-title"
            value={value.title}
            maxLength={100}
            onChange={(e) => change({ title: e.target.value })}
          />
          <label htmlFor="draft-prompt">What should it do?</label>
          <textarea
            id="draft-prompt"
            required
            rows={5}
            maxLength={3000}
            value={value.prompt}
            onChange={(e) => change({ prompt: e.target.value })}
          />
          <fieldset>
            <legend>Who is it for?</legend>
            <div className="app-recipients">
              {members.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    disabled={m.id === member.id}
                    checked={value.audience.includes(m.id)}
                    onChange={(e) =>
                      change({
                        audience: e.target.checked
                          ? [...value.audience, m.id]
                          : value.audience.filter((x) => x !== m.id),
                      })
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </fieldset>
          <p>
            Generation uses family context suitable for everyone selected. Your
            current app stays available while a new version is built.
          </p>
          <button className="primary" disabled={!value.prompt.trim()}>
            {app?.source || value.baseVersionId
              ? "Generate version"
              : value.status === "failed"
                ? "Retry from beginning"
                : "Create app"}
          </button>
        </fieldset>
      </form>
      {loaded && <AppBuildHistory appId={id} />}
    </section>
  );
}
