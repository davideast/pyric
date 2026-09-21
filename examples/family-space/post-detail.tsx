import React, { useEffect, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import {
  db,
  base,
  watchList,
  markViewed,
  addComment,
  editComment,
  removeComment,
  removePost,
  moderate,
  safeUrl,
  type Member,
  type Post,
  type Comment,
} from "./data";
import { Avatar, Media, Icon, ErrorNotice, clock, when, navigate } from "./ui";
import { Audience } from "./post-editor";
export function PostDetail({
  post,
  member,
  members,
}: {
  post: Post;
  member: Member;
  members: Member[];
}) {
  const [comments, setComments] = useState<Comment[]>([]),
    [views, setViews] = useState<string[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [audience, setAudience] = useState(post.audience),
    [editing, setEditing] = useState(""),
    [editText, setEditText] = useState(""),
    [deleting, setDeleting] = useState(false);
  const parent = member.role === "parent";
  const owner = post.authorId === member.id;
  useEffect(
    () =>
      watchList<Comment>(
        collection(db, `${base}/posts/${post.id}/comments`),
        setComments,
        (e) => setError(e.message),
      ),
    [post.id],
  );
  useEffect(() => {
    if (parent)
      return watchList<{ id: string }>(
        collection(db, `${base}/posts/${post.id}/views`),
        (v) => setViews(v.map((x) => x.id)),
        (e) => setError(e.message),
      );
    return onSnapshot(
      doc(db, `${base}/posts/${post.id}/views/${member.id}`),
      (snap) => setViews(snap.exists() ? [member.id] : []),
      (e) => setError(e.message),
    );
  }, [post.id, member.id, parent]);
  useEffect(() => {
    if (!parent && post.status === "published")
      void markViewed(post.id, member.id).catch((e) => setError(e.message));
  }, [post.id, post.status, member.id, parent]);
  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "That change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-layout">
      <article className="surface post-detail">
        {post.kind === "video" && (post.mediaPath || post.url) ? (
          <Media
            path={post.mediaPath}
            url={post.url}
            kind="video"
            alt={post.title}
            poster={post.cover}
          />
        ) : post.mediaPath ? (
          <Media path={post.mediaPath} kind="image" alt={post.title} />
        ) : post.cover ? (
          <img className="detail-cover" src={post.cover} alt={post.title} />
        ) : null}
        <div className="detail-copy">
          <div className="post-tags">
            <span>{post.kind}</span>
            <span>
              {post.audience.includes("family")
                ? "For our family"
                : `For ${members
                    .filter((m) => post.audience.includes(m.id))
                    .map((m) => m.name.split(" ")[0])
                    .join(" & ")}`}
            </span>
            {post.status !== "published" && (
              <span className="pending">
                {post.status === "pending" ? "Awaiting review" : "Not approved"}
              </span>
            )}
          </div>
          <h1>{post.title}</h1>
          <div className="byline">
            <Avatar member={members.find((m) => m.id === post.authorId)} />
            <div>
              <strong>
                {members.find((m) => m.id === post.authorId)?.name ??
                  "Family member"}
              </strong>
              <small>{when(post.createdAt)}</small>
            </div>
          </div>
          {post.kind === "event" && (
            <div className="event-banner">
              <Icon name="calendar" />
              <div>
                <strong>
                  {new Date(post.eventAt).toLocaleString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </strong>
                <span>{post.location}</span>
              </div>
            </div>
          )}
          <p className="article-body">{post.body}</p>
          {post.kind === "article" && post.url && safeUrl(post.url) && (
            <a
              className="text-link"
              href={safeUrl(post.url)}
              target="_blank"
              rel="noreferrer"
            >
              Read the linked article <Icon name="right" />
            </a>
          )}
          <div className="view-note">
            <Icon name="check" />
            {parent
              ? `Viewed by ${
                  views.length
                    ? members
                        .filter((m) => views.includes(m.id))
                        .map((m) => m.name.split(" ")[0])
                        .join(", ")
                    : "no kids yet"
                }`
              : views.includes(member.id)
                ? "Marked as viewed"
                : "Not viewed yet"}
          </div>
          {(parent || owner) && (
            <div className="post-owner-actions">
              <button
                className="text-link"
                onClick={() => navigate(`edit/${post.id}`)}
              >
                Edit post
              </button>
              <button className="danger-text" onClick={() => setDeleting(true)}>
                Delete post
              </button>
            </div>
          )}
          {deleting && (
            <div className="notice">
              Delete this post? It will be removed from all feeds.
              <div className="form-actions">
                <button onClick={() => setDeleting(false)}>Keep post</button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await removePost(post.id);
                      navigate("feed");
                    })
                  }
                >
                  Delete permanently
                </button>
              </div>
            </div>
          )}
          <ErrorNotice message={error} />
          <section className="comments">
            <h2>
              Conversation <span>{comments.length}</span>
            </h2>
            {comments
              .sort((a, b) => a.createdAt - b.createdAt)
              .map((c) => (
                <article className="comment" key={c.id}>
                  <Avatar member={members.find((m) => m.id === c.authorId)} />
                  <div>
                    <div className="comment-name">
                      <strong>
                        {members.find((m) => m.id === c.authorId)?.name ??
                          "Family member"}
                      </strong>
                      <small>{clock(c.createdAt)}</small>
                    </div>
                    {editing === c.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            await editComment(post.id, c.id, editText);
                            setEditing("");
                          });
                        }}
                      >
                        <textarea
                          aria-label="Edit comment"
                          required
                          maxLength={2000}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <button className="text-link" disabled={busy}>
                          Save
                        </button>
                        <button type="button" onClick={() => setEditing("")}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <p>{c.text}</p>
                    )}
                    {(parent || c.authorId === member.id) &&
                      editing !== c.id && (
                        <div className="comment-actions">
                          <button
                            onClick={() => {
                              setEditing(c.id);
                              setEditText(c.text);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(() => removeComment(post.id, c.id))
                            }
                          >
                            Delete
                          </button>
                        </div>
                      )}
                  </div>
                </article>
              ))}
            {!comments.length && (
              <p className="muted">Start a little conversation.</p>
            )}
            <form
              className="comment-compose"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim())
                  void act(async () => {
                    await addComment(post.id, member.id, text);
                    setText("");
                  });
              }}
            >
              <Avatar member={member} />
              <label className="sr-only" htmlFor="comment-text">
                Write a comment
              </label>
              <input
                id="comment-text"
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write a comment…"
              />
              <button className="primary" disabled={busy || !text.trim()}>
                Send
              </button>
            </form>
          </section>
        </div>
      </article>
      {parent && (
        <aside className="curation surface">
          <h2>Parent controls</h2>
          <p className="muted">Choose where this post belongs.</p>
          <Audience value={audience} onChange={setAudience} members={members} />
          <button
            className="primary"
            disabled={busy || !audience.length}
            onClick={() =>
              void act(() => moderate(post.id, "published", audience))
            }
          >
            {post.status === "published"
              ? "Save audience"
              : "Approve & publish"}
          </button>
          {post.status !== "rejected" && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  moderate(
                    post.id,
                    "rejected",
                    audience.length ? audience : post.audience,
                  ),
                )
              }
            >
              {post.status === "published"
                ? "Remove from feeds"
                : "Decline post"}
            </button>
          )}
          <p className="small muted">
            Kids can only edit their own content. Any edits to an approved kid
            post require your review again.
          </p>
        </aside>
      )}
    </div>
  );
}
