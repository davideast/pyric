import React, { useState } from "react";
import { savePost, type Post, type Member } from "./data";
import { Avatar, ErrorNotice, Icon, navigate } from "./ui";
export function Audience({
  value,
  onChange,
  members,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  members: Member[];
}) {
  return (
    <fieldset className="audience">
      <legend>Who is this for?</legend>
      <label>
        <input
          type="checkbox"
          checked={value.includes("family")}
          onChange={(e) => onChange(e.target.checked ? ["family"] : [])}
        />
        Everyone in the family
      </label>
      <div>
        {members
          .filter((m) => m.role === "kid")
          .map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={value.includes(m.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value.filter((v) => v !== "family"), m.id]
                      : value.filter((v) => v !== m.id),
                  )
                }
              />
              <Avatar member={m} />
              {m.name.split(" ")[0]}
            </label>
          ))}
      </div>
    </fieldset>
  );
}
export function PostEditor({
  member,
  members,
  post,
  initialKind,
}: {
  member: Member;
  members: Member[];
  post?: Post;
  initialKind?: Post["kind"];
}) {
  const [kind, setKind] = useState<Post["kind"]>(
      post?.kind ?? initialKind ?? "image",
    ),
    [title, setTitle] = useState(post?.title ?? ""),
    [body, setBody] = useState(post?.body ?? ""),
    [audience, setAudience] = useState(post?.audience ?? ["family"]),
    [url, setUrl] = useState(post?.url ?? ""),
    [eventAt, setEventAt] = useState(post?.eventAt ?? ""),
    [place, setPlace] = useState(post?.location ?? ""),
    [file, setFile] = useState<File>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const parent = member.role === "parent";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (parent && !audience.length) {
      setError("Choose the family or at least one kid.");
      return;
    }
    if (kind === "event" && !eventAt) {
      setError("Choose a date and time for the event.");
      return;
    }
    if (kind === "video" && !file && !url && !post?.mediaPath) {
      setError("Add a video file or a direct video URL.");
      return;
    }
    if (kind === "image" && !file && !post?.mediaPath && !post?.cover) {
      setError("Add a photo to this post.");
      return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      setError("Use a full http or https link.");
      return;
    }
    setBusy(true);
    try {
      const id = await savePost(
        member,
        {
          title: title.trim(),
          body: body.trim(),
          kind,
          status: parent ? "published" : "pending",
          audience,
          cover: post?.cover ?? "",
          url,
          eventAt,
          location: place,
        },
        post,
        file,
      );
      navigate(`post/${id}`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save this post. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="editor surface" onSubmit={submit}>
      <div className="editor-author">
        <Avatar member={member} />
        <div>
          <strong>{member.name}</strong>
          <span>
            {parent
              ? "Share something worth coming together for."
              : "A parent will review your post before it appears in a feed."}
          </span>
        </div>
      </div>
      <div className="type-picker" role="group" aria-label="Post type">
        {(["image", "video", "article", "event"] as const).map((k) => (
          <button
            type="button"
            key={k}
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
              setFile(undefined);
            }}
          >
            <Icon
              name={
                {
                  image: "camera",
                  video: "video",
                  article: "article",
                  event: "calendar",
                }[k]
              }
            />
            {k === "image" ? "Photo" : k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <label>
        Title
        <input
          required
          maxLength={140}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Give your family a reason to stop and smile"
        />
      </label>
      <label>
        {kind === "article" ? "Article" : "What would you like to share?"}
        <textarea
          required={kind === "article"}
          rows={7}
          maxLength={12000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell the story…"
        />
      </label>
      {(kind === "image" || kind === "video") && (
        <label className="file-field">
          <Icon name={kind === "image" ? "camera" : "video"} />
          {file
            ? file.name
            : `${post?.mediaPath || post?.cover ? "Replace" : "Add"} ${kind === "image" ? "photo" : "video"}`}
          <input
            aria-label={kind === "image" ? "Photo file" : "Video file"}
            type="file"
            accept={`${kind}/*`}
            onChange={(e) => setFile(e.target.files?.[0])}
          />
          <small>Up to 25 MB</small>
        </label>
      )}
      {(kind === "article" || kind === "video") && (
        <label>
          {kind === "video"
            ? "Or link to a video file"
            : "Article link (optional)"}
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
          />
        </label>
      )}
      {kind === "event" && (
        <div className="form-columns">
          <label>
            Date and time
            <input
              type="datetime-local"
              required
              value={eventAt}
              onChange={(e) => setEventAt(e.target.value)}
            />
          </label>
          <label>
            Location
            <input
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="Where are we meeting?"
              maxLength={160}
            />
          </label>
        </div>
      )}
      {parent && (
        <Audience value={audience} onChange={setAudience} members={members} />
      )}
      {!parent && post?.status === "published" && (
        <p className="notice">
          Your changes will return this post to parent review.
        </p>
      )}
      <ErrorNotice message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => navigate(post ? `post/${post.id}` : "feed")}
        >
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : parent ? "Publish post" : "Send for review"}
        </button>
      </div>
    </form>
  );
}
