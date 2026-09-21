import { localDraftApps } from "./app-drafts";
import { AppDetail } from "./app-detail";
import { restoreApp, purgeApp } from "./app-versions";
import React, { useEffect, useState } from "react";
import { collection, query, where } from "firebase/firestore";
import { base, db, watchList, type Member, type Post } from "./data";
import {
  loadTemplates,
  useTemplate,
  type AppTemplate,
} from "./template-store";
import { AppDraftEditor } from "./app-draft-editor";
import { ErrorNotice, Icon } from "./ui";

import { startGeneration, useGeneration, type FamilyApp } from "./generation";
export function FamilyApps({
  member,
  members,
  posts,
  appId,
}: {
  member: Member;
  members: Member[];
  posts: Post[];
  appId?: string;
}) {
  const [apps, setApps] = useState<FamilyApp[]>([]),
    [current, setCurrent] = useState<FamilyApp | null>(null);
  const [audience, setAudience] = useState<string[]>([member.id]),
    [error, setError] = useState("");
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<AppTemplate | null>(
    null,
  );
  const [templateBusy, setTemplateBusy] = useState("");
  const [editor, setEditor] = useState<{ id: string; app?: FamilyApp } | null>(
    null,
  );
  const job = useGeneration();
  const busy = job?.state === "running";
  const editingRoute = location.hash.endsWith("/draft");
  useEffect(() => {
    if (!appId) {
      setCurrent(null);
      setSelectedTemplate(null);
    }
    if (appId) {
      const selected =
        apps.find((a) => a.id === appId) ??
        localDraftApps(member.id).find((a) => a.id === appId) ??
        (job?.draft?.id === appId ? job.draft : undefined);
      if (selected && !selected.deletedAt) {
        if (editingRoute) {
          setCurrent(null);
          setEditor({ id: selected.id, app: selected });
        } else setCurrent(selected);
      }
    }
  }, [appId, apps, job?.draft, editingRoute]);
  const parent = member.role === "parent";
  useEffect(() => {
    let disposed = false;
    loadTemplates(parent)
      .then((items) => {
        if (!disposed) setTemplates(items);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [member.id, parent]);
  async function createFromTemplate(template: AppTemplate) {
    if (templateBusy) return;
    setTemplateBusy(template.id);
    setError("");
    try {
      const app = await useTemplate(template, member, members, posts, audience);
      setCurrent(app);
      location.hash = "apps/" + app.id;
    } catch (e) {
      setError(String(e));
    } finally {
      setTemplateBusy("");
    }
  }
  useEffect(() => {
    const batches: FamilyApp[][] = [[], []];
    const emit = () =>
      setApps(
        [...new Map(batches.flat().map((a) => [a.id, a])).values()].sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
      );
    const source = collection(db, base + "/apps");
    const stops = [
      watchList<FamilyApp>(
        query(source, where("ownerId", "==", member.id)),
        (items) => {
          batches[0] = items;
          emit();
        },
        (e) => setError(e.message),
      ),
      watchList<FamilyApp>(
        query(
          source,
          where("published", "==", true),
          where("audience", "array-contains", member.id),
        ),
        (items) => {
          batches[1] = items;
          emit();
        },
        (e) => setError(e.message),
      ),
    ];
    return () => {
      stops.forEach((s) => s());
    };
  }, [member.id]);
  // A revoked share disappears immediately, including its data subscription.
  const active =
    current &&
    (current.ownerId === member.id
      ? current
      : apps.find((a) => a.id === current.id));
  if (current && !active)
    return (
      <section className="surface app-builder">
        <h2>This app is no longer shared with you.</h2>
        <button className="secondary" onClick={() => setCurrent(null)}>
          Back to apps
        </button>
      </section>
    );
  return (
    <section className="family-apps">
      <ErrorNotice message={error} />
      {active ? (
        <AppDetail
          key={active.id}
          onRepair={(error, baseVersionId, candidate) => {
            startGeneration({
              member,
              members,
              posts,
              title: candidate.title,
              prompt: candidate.prompt,
              audience: candidate.audience,
              baseVersionId,
              repair: { app: candidate, error },
            });
            location.hash = "build";
          }}
          app={active}
          owner={parent && active.ownerId === member.id}
          onBack={() => {
            setCurrent(null);
            location.hash = "apps";
          }}
          onEdit={(baseVersionId) => {
            setEditor({
              id: active.id,
              app: { ...active, activeVersionId: baseVersionId },
            });
            setCurrent(null);
            location.hash = "apps";
          }}
        />
      ) : selectedTemplate && parent ? (
        <section className="surface app-builder">
          <button
            className="back-link"
            onClick={() => setSelectedTemplate(null)}
          >
            All apps
          </button>
          <h2>{selectedTemplate.title}</h2>
          <p>{selectedTemplate.description}</p>
          <fieldset>
            <legend>Who is it for?</legend>
            <p>
              Your copy starts private. Select who you want to share it with
              after trying it.
            </p>
            <div className="app-recipients">
              {members.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={audience.includes(m.id)}
                    disabled={m.id === member.id}
                    onChange={(e) =>
                      setAudience(
                        e.target.checked
                          ? [...audience, m.id]
                          : audience.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <button
              className="primary"
              disabled={!!templateBusy}
              onClick={() => void createFromTemplate(selectedTemplate)}
            >
              {templateBusy ? "Creating…" : "Create from template"}
            </button>
          </div>
        </section>
      ) : editor && parent ? (
        <AppDraftEditor
          key={editor.id}
          {...editor}
          member={member}
          members={members}
          posts={posts}
          busy={busy}
          onBack={() => {
            setEditor(null);
            location.hash = "apps";
          }}
        />
      ) : (
        <>
          <div className="app-builder-heading">
            <div>
              <h2>Made for your family</h2>
              <p>Little apps for everyday moments.</p>
            </div>
            {parent && (
              <button
                className="primary"
                onClick={() => {
                  setEditor({ id: crypto.randomUUID() });
                  setAudience([member.id]);
                  setError("");
                }}
              >
                <Icon name="plus" />
                Create app
              </button>
            )}
          </div>
          {parent && templates.length > 0 && (
            <section className="app-templates" aria-label="App templates">
              <header>
                <h3>Start with something good</h3>
                <p>
                  Ten little apps, ready to make your own. Each starts with
                  fresh data.
                </p>
              </header>
              {(
                [
                  ["practical", "Useful, with a little fun"],
                  ["fun", "Just for fun"],
                ] as const
              ).map(([tone, label]) => (
                <section key={tone} className="template-group">
                  <h4>{label}</h4>
                  <div className="template-list">
                    {templates
                      .filter((t) => t.tone === tone)
                      .map((t) => (
                        <article className="template-row" key={t.id}>
                          <div>
                            <h4>{t.title}</h4>
                            <p>{t.description}</p>
                          </div>
                          <button
                            className="secondary"
                            disabled={!!templateBusy}
                            aria-label={`Use ${t.title} template`}
                            onClick={() => {
                              setSelectedTemplate(t);
                              setAudience([member.id]);
                              setError("");
                            }}
                          >
                            {templateBusy === t.id
                              ? "Creating…"
                              : "Use template"}
                          </button>
                        </article>
                      ))}
                  </div>
                </section>
              ))}
            </section>
          )}
          <h3>Your apps</h3>
          {!apps.length && (
            <div className="surface app-builder">
              <h3>No apps yet</h3>
              <p>
                {parent
                  ? "Describe something useful or fun, preview it, then share it with your family."
                  : "Apps shared with you will appear here."}
              </p>
            </div>
          )}
          <div className="family-app-grid">
            {[
              ...apps,
              ...localDraftApps(member.id).filter(
                (a) => !apps.some((saved) => saved.id === a.id),
              ),
            ]
              .filter((a) => !a.deletedAt)
              .map((a) => (
                <button
                  className="surface family-app-card"
                  key={a.id}
                  aria-label={
                    !a.source && !a.versionCount
                      ? `Continue draft ${a.title}`
                      : undefined
                  }
                  onClick={() => {
                    if (!a.source && !a.versionCount) {
                      location.hash = "apps/" + a.id + "/draft";
                      setEditor({ id: a.id, app: a });
                      return;
                    }
                    location.hash = "apps/" + a.id;
                    setCurrent(a);
                    setError("");
                  }}
                >
                  <Icon name="apps" />
                  <h3>{a.title}</h3>
                  <p>{a.published ? "Shared with you" : "Private draft"}</p>
                  <span>Open app →</span>
                </button>
              ))}
          </div>
          {parent && (
            <details className="app-context">
              <summary>Trash</summary>
              {apps
                .filter((a) => a.deletedAt && a.ownerId === member.id)
                .map((a) => (
                  <div className="template-row" key={a.id}>
                    <span>{a.title}</span>
                    <button
                      className="secondary"
                      onClick={() =>
                        void restoreApp(a.id).catch((e) => setError(String(e)))
                      }
                    >
                      Restore {a.title}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Permanently delete this app, its history, and all saved records?",
                          )
                        )
                          void purgeApp(a.id).catch((e) => setError(String(e)));
                      }}
                    >
                      Delete permanently
                    </button>
                  </div>
                ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
