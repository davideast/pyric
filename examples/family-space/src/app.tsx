import "./diagnostics/remote-diagnostics";
import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  onAuthStateChanged,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
  type User,
} from "firebase/auth";
import { auth, watchMembers, watchPosts, type Member, type Post } from "./data";
import { Avatar, Empty, ErrorNotice, Icon, Media, navigate, when } from "./ui/ui";
import { PostEditor } from "./family/post-editor";
import { PostDetail } from "./family/post-detail";
import { FamilyChat } from "./family/chat";
import { Schedule } from "./family/schedule";
import "./ui/styles.css";
import { GenerationBar, GenerationStatus } from "./apps/generation/generation-ui";
const EMAIL_KEY = "kin:sign-in-email";
const FamilyApps = React.lazy(() =>
  import("./apps/family-apps").then((module) => ({ default: module.FamilyApps })),
);
function rememberedEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}
function clearLink() {
  history.replaceState(null, "", location.pathname + "#feed");
}
function SignIn({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState(rememberedEmail),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false);
  const [completing, setCompleting] = useState(() =>
    isSignInWithEmailLink(auth, location.href),
  );
  const attempted = useRef(false);
  async function complete(address: string) {
    setBusy(true);
    setError("");
    try {
      await signInWithEmailLink(auth, address.trim(), location.href);
      try {
        localStorage.removeItem(EMAIL_KEY);
      } catch {}
      clearLink();
      onComplete();
    } catch {
      setError(
        "This link could not sign you in. Check that the email matches, or request a new link if it has expired or was already used.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (completing && !attempted.current) {
      attempted.current = true;
      const saved = rememberedEmail();
      if (saved) void complete(saved);
    }
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (completing) {
      await complete(email);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await sendSignInLinkToEmail(auth, email.trim(), {
        url: location.origin + location.pathname,
        handleCodeInApp: true,
      });
      try {
        localStorage.setItem(EMAIL_KEY, email.trim());
      } catch {}
      setSent(true);
    } catch {
      setError(
        "We couldn’t send your sign-in link. Check the email address and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="welcome">
      <section className="welcome-story">
        <a className="brand" href="#">
          kin<span>●</span>
        </a>
        <div>
          <h1>
            A little closer.
            <br />
            Every day.
          </h1>
          <p>
            The big plans, the small wins, and everything that makes your family
            yours.
          </p>
        </div>
        <img src="/assets/paddle.png" alt="An afternoon on turquoise water" />
        <span className="welcome-caption">Less scrolling. More together.</span>
      </section>
      <section className="welcome-form">
        <div className="sign-in">
          <h2>
            {completing
              ? "Welcome back."
              : sent
                ? "Check your email."
                : "Your family is here."}
          </h2>
          <p>
            {completing
              ? "Confirm the email you used to request this link."
              : sent
                ? `We sent a sign-in link to ${email}. Open it to come on in.`
                : "Enter your email and we’ll send you a sign-in link. No password needed."}
          </p>
          <form onSubmit={submit}>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                disabled={busy}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setSent(false);
                }}
              />
            </label>
            <ErrorNotice message={error} />
            <button className="primary" disabled={busy}>
              {busy
                ? completing
                  ? "Signing in…"
                  : "Sending…"
                : completing
                  ? "Confirm & sign in"
                  : sent
                    ? "Send another link"
                    : "Send sign-in link"}
              <Icon name="right" />
            </button>
          </form>
          {completing && (
            <button
              className="text-link"
              style={{ marginTop: 20 }}
              disabled={busy}
              onClick={() => {
                clearLink();
                setCompleting(false);
                setError("");
                setSent(false);
              }}
            >
              Request a new link
            </button>
          )}
          {!completing && (
            <details className="demo-accounts">
              <summary>Try the example family</summary>
              <p>Choose a family email, then request your sign-in link.</p>
              {["emma", "daniel", "sam", "zoe"].map((name, i) => (
                <button
                  key={name}
                  onClick={() => {
                    setEmail(`${name}@kin.example`);
                    setSent(false);
                  }}
                >
                  <span>
                    {name[0].toUpperCase() + name.slice(1)}{" "}
                    <small>{i < 2 ? "Parent" : "Kid"}</small>
                  </span>
                  <span>{name}@kin.example</span>
                </button>
              ))}
            </details>
          )}
        </div>
      </section>
    </main>
  );
}
function PostCard({ post, members }: { post: Post; members: Member[] }) {
  const author = members.find((m) => m.id === post.authorId);
  return (
    <article className="post-card surface">
      <div className="post-byline">
        <Avatar member={author} />
        <div>
          <strong>{author?.name ?? "Family member"}</strong>
          <span>
            {when(post.createdAt)} ·{" "}
            {post.audience.includes("family")
              ? "Family"
              : post.audience
                  .map(
                    (id) =>
                      members.find((m) => m.id === id)?.name.split(" ")[0],
                  )
                  .filter(Boolean)
                  .join(" & ")}
          </span>
        </div>
        <span className={`tag ${post.status === "pending" ? "pending" : ""}`}>
          {post.status === "published"
            ? post.kind === "image"
              ? "Photo"
              : post.kind
            : post.status === "pending"
              ? "In review"
              : "Needs changes"}
        </span>
      </div>
      <button className="post-open" onClick={() => navigate(`post/${post.id}`)}>
        {post.kind === "image" && (post.mediaPath || post.cover) && (
          <div className="card-media">
            <Media
              path={post.mediaPath}
              url={post.cover}
              kind="image"
              alt={post.title}
            />
          </div>
        )}
        {post.kind !== "image" && post.kind !== "video" && post.cover && (
          <img className="card-cover" src={post.cover} alt="" />
        )}
        {post.kind === "video" && (
          <div className="card-media video-cover">
            {post.cover && (
              <img className="card-cover" src={post.cover} alt="" />
            )}
            <div className="video-preview">
              <span className="video-play">
                <Icon name="play" />
              </span>
              <span>Watch together</span>
            </div>
          </div>
        )}
        <div className="card-copy">
          {post.kind === "event" && (
            <p className="event-kicker">
              {new Date(post.eventAt).toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}{" "}
              ·{" "}
              {new Date(post.eventAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
          <h2>{post.title}</h2>
          <p>{post.body}</p>
          <span className="card-action">
            {post.status === "pending" ? "Read & review" : "Open post"}
            <Icon name="right" />
          </span>
        </div>
      </button>
    </article>
  );
}
function Workspace({ user }: { user: User }) {
  const [members, setMembers] = useState<Member[]>([]),
    [posts, setPosts] = useState<Post[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [route, setRoute] = useState(location.hash.slice(1) || "feed"),
    [kid, setKid] = useState(""),
    [menu, setMenu] = useState(false);
  const member = members.find((m) => m.id === user.uid);
  useEffect(
    () =>
      watchMembers(
        (items) => {
          setMembers(items);
          setReady(true);
        },
        (e) => {
          setError(e.message);
          setReady(true);
        },
      ),
    [],
  );
  useEffect(() => {
    if (!member) return;
    setPosts([]);
    return watchPosts(member, setPosts, (e) => setError(e.message));
  }, [member?.id, member?.role]);
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "feed");
      setMenu(false);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const navigationRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const mobile = window.matchMedia("(max-width: 680px)");
    if (!mobile.matches) {
      setMenu(false);
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = navigationRef.current;
    panel?.querySelector<HTMLButtonElement>(".navigation-close")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false);
      }
      if (event.key === "Tab" && panel) {
        const controls = [
          ...panel.querySelectorAll<HTMLElement>(
            "a[href],button:not([disabled])",
          ),
        ];
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const resize = () => {
      if (!mobile.matches) setMenu(false);
    };
    document.addEventListener("keydown", keydown);
    mobile.addEventListener("change", resize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      mobile.removeEventListener("change", resize);
      if (mobile.matches) menuButtonRef.current?.focus();
    };
  }, [menu]);
  if (!ready)
    return (
      <main className="loading" role="status">
        Getting your family together…
      </main>
    );
  if (!member)
    return (
      <main className="loading">
        <h1>This account is not in the Parker family.</h1>
        <ErrorNotice message={error} />
        <button onClick={() => void signOut(auth)}>Sign out</button>
      </main>
    );
  const parent = member.role === "parent",
    kids = members.filter((m) => m.role === "kid"),
    selectedKid = parent ? kid || kids[0]?.id : member.id;
  const [page, id] = route.split("/");
  const post = posts.find((p) => p.id === id);
  const pending = posts.filter((p) => p.status === "pending");
  const titles: Record<string, string> = {
    apps: "Family apps",
    build: "App activity",
    feed: "Our family",
    mine: "Just for you",
    own: "Your posts",
    schedule: "Making time",
    chat: "Family chat",
    review: "Parent review",
    compose: "Something to share",
    post: "Together, in the details",
    edit: "Make it yours",
    profile: "Your family",
  };
  const nav = [
    ["feed", "home", "Family"],
    ["mine", "user", parent ? "Kid feeds" : "For you"],
    ["schedule", "calendar", "Schedule"],
    ["chat", "chat", "Chat"],
    ["apps", "apps", "Apps"],
  ];
  const visible = posts
    .filter((p) =>
      page === "review"
        ? p.status === "pending"
        : page === "own"
          ? p.authorId === member.id
          : page === "mine"
            ? p.status === "published" && p.audience.includes(selectedKid)
            : p.status === "published" && p.audience.includes("family"),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const list = ["feed", "mine", "own", "review"].includes(page);
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="navigation-backdrop"
          aria-label="Dismiss navigation"
          tabIndex={-1}
          onClick={() => setMenu(false)}
        />
      )}
      <aside
        ref={navigationRef}
        id="family-navigation"
        className={`sidebar ${menu ? "open" : ""}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a[href]")) setMenu(false);
        }}
      >
        <button
          className="navigation-close"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        >
          <Icon name="back" />
          Close
        </button>
        <a href="#feed" className="brand">
          kin<span>●</span>
        </a>
        <p className="sidebar-family">
          The Parkers<span>A space for us.</span>
        </p>
        <nav aria-label="Main navigation">
          {nav.map(([key, icon, label]) => (
            <a
              key={key}
              href={`#${key}`}
              aria-current={page === key ? "page" : undefined}
            >
              <Icon name={icon} active={page === key} />
              {label}
            </a>
          ))}
          <a href="#own" aria-current={page === "own" ? "page" : undefined}>
            <Icon name="article" active={page === "own"} />
            My posts
          </a>
          {parent && (
            <a
              href="#review"
              aria-current={page === "review" ? "page" : undefined}
            >
              <Icon name="check" active={page === "review"} />
              Parent review
              {pending.length > 0 && <b className="count">{pending.length}</b>}
            </a>
          )}
        </nav>
        <div className="sidebar-note">
          For the people
          <br />
          who matter most.
        </div>
        <a className="account" href="#profile">
          <Avatar member={member} />
          <div>
            <strong>{member.name.split(" ")[0]}</strong>
            <span>{parent ? "Parent" : "Family member"}</span>
          </div>
        </a>
        <button
          className="sign-out text-link"
          onClick={() => void signOut(auth)}
        >
          Sign out
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            ref={menuButtonRef}
            aria-expanded={menu}
            aria-controls="family-navigation"
            aria-label="Toggle navigation"
            onClick={() => setMenu(!menu)}
          >
            <Icon name="menu" />
          </button>
          <div>
            <h1>{titles[page] ?? "Our family"}</h1>
          </div>
          <div className="header-actions">
            {parent && (
              <a
                className="review-link icon-button"
                href="#review"
                aria-label={`Parent review, ${pending.length} pending`}
              >
                <Icon name="bell" />
                {pending.length > 0 && <i />}
              </a>
            )}
            <button
              className="primary create"
              aria-label="New post"
              onClick={() => navigate("compose")}
            >
              <Icon name="plus" />
              <span>New post</span>
            </button>
          </div>
        </header>
        <div
          className={`content-layout ${["build", "apps", "chat", "schedule", "compose", "edit", "post"].includes(page) ? "wide" : ""}`}
        >
          <main className="main-content">
            <ErrorNotice message={error} />
            {list && (
              <>
                <div className="feed-intro">
                  <h2>
                    {page === "feed"
                      ? `Hey ${member.name.split(" ")[0]}, make yourself at home.`
                      : page === "mine"
                        ? parent
                          ? "A little something just for them."
                          : "Picked with you in mind."
                        : page === "review"
                          ? "Good things start with a little care."
                          : "Your corner of the family."}
                  </h2>
                  <p>
                    {page === "feed"
                      ? "The moments and plans we share."
                      : page === "mine"
                        ? "A thoughtful feed, curated by your parents."
                        : page === "review"
                          ? "Review kid posts and choose where they belong."
                          : "Keep track of what you’ve shared and what’s waiting for review."}
                  </p>
                </div>
                {page === "mine" && parent && (
                  <div className="kid-tabs" aria-label="Choose kid feed">
                    {kids.map((k) => (
                      <button
                        aria-pressed={selectedKid === k.id}
                        key={k.id}
                        onClick={() => setKid(k.id)}
                      >
                        <Avatar member={k} />
                        {k.name.split(" ")[0]}
                      </button>
                    ))}
                  </div>
                )}
                {page === "feed" && (
                  <button
                    className="compose-prompt surface"
                    onClick={() => navigate("compose")}
                  >
                    <Avatar member={member} />
                    <span>What made you smile today?</span>
                    <Icon name="camera" />
                  </button>
                )}
                <div className="feed">
                  {visible.map((p) => (
                    <PostCard key={p.id} post={p} members={members} />
                  ))}
                  {!visible.length && (
                    <Empty
                      title={
                        page === "review"
                          ? "All caught up"
                          : "A little space for something good"
                      }
                    >
                      {page === "review"
                        ? "New kid posts will appear here for your review."
                        : page === "mine"
                          ? "Posts chosen for this kid will appear here."
                          : "Share a photo, an article, or a plan for your family."}
                    </Empty>
                  )}
                </div>
              </>
            )}
            {page === "compose" && (
              <PostEditor
                key={route}
                member={member}
                members={members}
                initialKind={id === "event" ? "event" : undefined}
              />
            )}
            {page === "edit" &&
              (post && (parent || post.authorId === member.id) ? (
                <PostEditor
                  key={post.id}
                  member={member}
                  members={members}
                  post={post}
                />
              ) : (
                <Empty title="This post is not available" />
              ))}
            {page === "post" &&
              (post ? (
                <>
                  <button
                    className="back-link"
                    onClick={() => navigate("feed")}
                  >
                    <Icon name="back" />
                    Back to family
                  </button>
                  <PostDetail
                    key={post.id}
                    post={post}
                    member={member}
                    members={members}
                  />
                </>
              ) : (
                <Empty title="This post is not available">
                  It may be private, removed, or waiting for parent approval.
                </Empty>
              ))}
            {page === "build" && <GenerationStatus />}
            {page === "apps" && (
              <React.Suspense fallback={<p role="status">Opening apps…</p>}>
                <FamilyApps
                  key={member.id}
                  appId={id}
                  member={member}
                  members={members}
                  posts={posts}
                />
              </React.Suspense>
            )}
            {page === "schedule" && <Schedule posts={posts} parent={parent} />}{" "}
            {page === "chat" && (
              <FamilyChat member={member} members={members} />
            )}{" "}
            {page === "profile" && (
              <section className="surface family-panel">
                <h2>Our people</h2>
                {members.map((m) => (
                  <div className="person" key={m.id}>
                    <Avatar member={m} />
                    <div>
                      <strong>{m.name}</strong>
                      <span>
                        {m.role === "parent"
                          ? "Parent · Curates & approves"
                          : "Kid · Creates & joins in"}
                      </span>
                    </div>
                  </div>
                ))}
                <button
                  className="secondary"
                  onClick={() => void signOut(auth)}
                >
                  Sign out
                </button>
              </section>
            )}
          </main>
          {!["build", "apps", "chat", "schedule", "compose", "edit", "post"].includes(
            page,
          ) && (
            <aside className="family-aside">
              <section>
                <p className="eyebrow">OUR PEOPLE</p>
                <div className="family-portraits">
                  {members.map((m) => (
                    <div key={m.id}>
                      <Avatar member={m} large />
                      <span>{m.name.split(" ")[0]}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="next-up">
                <div className="aside-heading">
                  <h2>Next together</h2>
                  <a href="#schedule">
                    <Icon name="right" />
                  </a>
                </div>
                {posts
                  .filter(
                    (p) =>
                      p.kind === "event" &&
                      p.status === "published" &&
                      new Date(p.eventAt) > new Date(),
                  )
                  .sort((a, b) => a.eventAt.localeCompare(b.eventAt))
                  .slice(0, 3)
                  .map((p) => (
                    <button key={p.id} onClick={() => navigate(`post/${p.id}`)}>
                      <div className="event-date">
                        <strong>{new Date(p.eventAt).getDate()}</strong>
                        <small>
                          {new Date(p.eventAt).toLocaleDateString(undefined, {
                            month: "short",
                          })}
                        </small>
                      </div>
                      <div>
                        <strong>{p.title}</strong>
                        <span>{p.location}</span>
                      </div>
                    </button>
                  ))}
                <p className="aside-foot">Little plans. Lovely memories.</p>
              </section>
              <div className="family-reminder">
                <p>
                  Not everything
                  <br />
                  needs a big occasion.
                </p>
                <span>A note. A photo. A moment together.</span>
              </div>
            </aside>
          )}
        </div>
      </div>
      <GenerationBar ownerId={member.id} />
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {nav.map(([key, icon, label]) => (
          <a
            key={key}
            href={`#${key}`}
            aria-current={page === key ? "page" : undefined}
          >
            <Icon name={icon} active={page === key} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
function App() {
  const [finishingLink, setFinishingLink] = useState(() =>
    isSignInWithEmailLink(auth, location.href),
  );
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return finishingLink ? (
    <SignIn onComplete={() => setFinishingLink(false)} />
  ) : user === undefined ? (
    <main className="loading" role="status">
      Opening Kin…
    </main>
  ) : user ? (
    <Workspace key={user.uid} user={user} />
  ) : (
    <SignIn onComplete={() => setFinishingLink(false)} />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
