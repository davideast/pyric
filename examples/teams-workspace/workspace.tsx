import { Notifications, useNotifications } from "./notifications";
import { Assistant } from "./assistant";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { warningScenarios, warningBurstPlan } from "./scenarios";
import { SignIn } from "./sign-in";
import { Icon } from "./icons";
import {
  auth,
  connectPresence,
  db,
  rtdb,
  people,
  channels,
  listenMessages,
  listenRealtime,
  send,
  reactTo,
  presence,
  typing,
  searchMessages,
  type Message,
} from "./data";
function workspacePeople() {
  const current = auth.currentUser;
  return current && !people.some((person) => person.uid === current.uid)
    ? [
        ...people,
        {
          uid: current.uid,
          name: current.displayName || current.email || "You",
          role: "Member",
        },
      ]
    : people;
}
function memberName(uid: string) {
  return (
    workspacePeople()
      .find((person) => person.uid === uid)
      ?.name.split(" ")[0] ?? "A teammate"
  );
}
function Avatar({ uid, small = false }: { uid: string; small?: boolean }) {
  const person = workspacePeople().find((person) => person.uid === uid);
  const current = auth.currentUser?.uid === uid ? auth.currentUser : null;
  const name = current
    ? current.displayName || current.email || "Member"
    : (person?.name ?? "Member");
  const portraits: Record<string, number> = {
    david: 12,
    alice: 47,
    marcus: 13,
    avery: 49,
  };
  const portrait = portraits[uid];
  const photo = current
    ? current.photoURL
    : portrait
      ? `https://i.pravatar.cc/80?img=${portrait}`
      : null;
  return photo ? (
    <img className={`avatar ${small ? "small" : ""}`} src={photo} alt="" />
  ) : (
    <span
      className={`avatar initials ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
function Action({
  name,
  label,
  onClick,
}: {
  name: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon name={name} />
    </button>
  );
}
function useRealtime(path: string, name: string) {
  const element = useRef<HTMLDivElement>(null);
  const [value, set] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!element.current) return;
    return listenRealtime(path, (next) =>
      queueMicrotask(() => flushSync(() => set(next))),
    );
  }, [path, name]);
  return { element, value };
}
function HeaderMembers({ onClick }: { onClick: () => void }) {
  const { element, value } = useRealtime("presence", "HeaderPresence");
  return (
    <div ref={element}>
      <button className="member-stack" aria-label="Show team" onClick={onClick}>
        {workspacePeople()
          .slice(0, 3)
          .map((person) => (
            <span className="avatar-wrap" key={person.uid}>
              <Avatar uid={person.uid} small />
              <span className={`presence ${value[person.uid] ?? "offline"}`} />
            </span>
          ))}
      </button>
    </div>
  );
}
function Members() {
  const { element, value } = useRealtime("presence", "TeamPresence");
  return (
    <div ref={element} className="members">
      <div className="section-label">
        Team <span>{workspacePeople().length}</span>
      </div>
      {workspacePeople().map((person) => (
        <div className="member" key={person.uid}>
          <div className="avatar-wrap">
            <Avatar uid={person.uid} />
            <span className={`presence ${value[person.uid] ?? "offline"}`} />
          </div>
          <div>
            <strong>{person.name}</strong>
            <small>{value[person.uid] ?? "offline"}</small>
          </div>
        </div>
      ))}
    </div>
  );
}
function Typing({ channel }: { channel: string }) {
  const { element, value } = useRealtime(
    `typing/${channel}`,
    "TypingIndicator",
  );
  const names = Object.entries(value)
    .filter(([, status]) => status === "typing")
    .map(([uid]) => memberName(uid));
  return (
    <div ref={element} className="typing">
      {names.length
        ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…`
        : " "}
    </div>
  );
}
function Receipts({ channel }: { channel: string }) {
  const { element, value } = useRealtime(`receipts/${channel}`, "ReadReceipts");
  return (
    <div ref={element} className="receipts">
      {Object.keys(value).length ? (
        <>
          <Icon name="check" /> Seen by{" "}
          {Object.keys(value)
            .map((uid) => memberName(uid))
            .join(", ")}
        </>
      ) : (
        "Messages are shared with your team"
      )}
    </div>
  );
}
function Composer({
  channel,
  user,
  parent = "",
  onSent,
}: {
  channel: string;
  user: string;
  parent?: string;
  onSent?: () => void;
}) {
  const [text, setText] = useState(""),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (auth.currentUser?.uid === user)
        void typing(channel, user, false).catch(() => {});
    },
    [channel, user],
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || (!text.trim() && !file)) return;
    setBusy(true);
    setError("");
    try {
      await send(channel, user, text.trim(), parent, file);
      setText("");
      setFile(undefined);
      await typing(channel, user, false);
      onSent?.();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Message could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="composer" onSubmit={submit}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {file && (
        <div className="file-chip">
          <Icon name="file" />
          {file.name}
          <Action
            name="close"
            label="Remove attachment"
            onClick={() => setFile(undefined)}
          />
        </div>
      )}
      <textarea
        aria-label={parent ? "Reply" : "Message"}
        placeholder={
          parent
            ? "Write a reply…"
            : `Message #${channels.find((c) => c.id === channel)?.name}`
        }
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          void typing(channel, user, true);
          clearTimeout(timer.current);
          timer.current = setTimeout(
            () => void typing(channel, user, false),
            1500,
          );
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-tools">
        <input
          type="file"
          ref={input}
          hidden
          onChange={(event) => {
            setFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Action
          name="attach"
          label="Attach a file"
          onClick={() => input.current?.click()}
        />
        <span>Enter to send</span>
        <button
          className="send"
          disabled={busy || (!text.trim() && !file)}
          aria-label={busy ? "Sending" : "Send message"}
        >
          <Icon name="send" />
        </button>
      </div>
    </form>
  );
}
function MessageRow({
  message,
  channel,
  replies,
  onThread,
}: {
  message: Message;
  channel: string;
  replies: number;
  onThread?: () => void;
}) {
  const [error, setError] = useState("");
  const author = workspacePeople().find((p) => p.uid === message.author) ?? {
    name: message.authorName || "Teammate",
  };
  return (
    <article className="message" data-message-id={message.id}>
      <Avatar uid={message.author} />
      <div className="message-content">
        <div className="message-byline">
          <strong>{author?.name ?? message.author}</strong>
          <time>
            {new Date(message.created).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <p>{message.text}</p>
        {message.attachment && (
          <a
            className="attachment"
            href={message.attachment}
            download={message.fileName}
          >
            <Icon name="file" />
            <span>
              {message.fileName}
              <small>Shared attachment</small>
            </span>
          </a>
        )}
        {message.id === "seed-2" && channel === "design" && (
          <div className="design-preview">
            <div className="preview-orbits">
              <span />
              <span />
              <span />
            </div>
            <div>
              <small>ORBIT / FALL 2026</small>
              <strong>
                Good work
                <br />
                happens together.
              </strong>
            </div>
          </div>
        )}
        <div className="message-actions">
          <button
            aria-label={`React to message by ${author?.name}`}
            className={message.reactions ? "reacted" : ""}
            onClick={() =>
              void reactTo(channel, message).catch((e) => setError(e.message))
            }
          >
            <Icon name="heart" />
            {message.reactions || "React"}
          </button>
          {onThread && (
            <button onClick={onThread}>
              <Icon name="chat" />
              {replies
                ? `${replies} ${replies === 1 ? "reply" : "replies"}`
                : "Reply"}
            </button>
          )}
        </div>
        {error && <small className="error">{error}</small>}
      </div>
    </article>
  );
}
function ScenarioPanel({ channel, user }: { channel: string; user: string }) {
  const [busy, setBusy] = useState(""),
    [result, setResult] = useState("");
  const cancel = useRef(false);
  useEffect(
    () => () => {
      cancel.current = true;
    },
    [],
  );
  const warnings = warningScenarios;
  async function run(name: string, task: () => Promise<unknown>) {
    setBusy(name);
    setResult("");
    cancel.current = false;
    try {
      await task();
      setResult(`${name} completed. Inspect Traffic in the Pyric chip.`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }
  const scenarios = [
    {
      name: "Team conversation",
      detail: "Messages, typing and receipts across both services.",
      task: async () => {
        for (let i = 0; i < 8 && !cancel.current; i++) {
          const uid = i % 2 ? "alice" : "marcus";
          await typing(channel, uid, true);
          await new Promise((r) => setTimeout(r, 550));
          await send(
            channel,
            uid,
            [
              "The updated draft is ready for review.",
              "That spacing is much easier to scan.",
              "I’ve added my feedback to the thread.",
              "Let’s take this version into the review.",
            ][i % 4]!,
          );
          await typing(channel, uid, false);
          await presence(uid, i % 3 ? "online" : "away");
        }
      },
    },
    {
      name: "Firestore write surge",
      detail: "Sustained writes exceed the configured warning threshold.",
      task: async () => {
        const plan = await warningBurstPlan("firestore");
        for (let i = 0; i < plan.count && !cancel.current; i++) {
          await send(channel, user, `Review activity ${i + 1}`);
          await new Promise((r) => setTimeout(r, plan.delay));
        }
      },
    },
    {
      name: "RTDB presence surge",
      detail: "Frequent presence updates trigger the RTDB write warning.",
      task: async () => {
        const plan = await warningBurstPlan("rtdb");
        for (let i = 0; i < plan.count && !cancel.current; i++) {
          await presence("alice", i % 2 ? "online" : "away");
          await new Promise((r) => setTimeout(r, plan.delay));
        }
      },
    },
    {
      name: "Denied Firestore write",
      detail: "A negative budget fails a validation rule.",
      task: warnings.firestoreDenial,
    },
    {
      name: "Denied RTDB write",
      detail: "A negative budget fails an RTDB validation rule.",
      task: warnings.rtdbDenial,
    },
    {
      name: "Missing Firestore index",
      detail: "A fresh filtered and sorted query needs an index.",
      task: warnings.firestoreIndex,
    },
    {
      name: "Missing RTDB .indexOn",
      detail: "A fresh ordered query needs a local rule index.",
      task: warnings.rtdbIndex,
    },
  ];
  return (
    <>
      <div className="rail-heading">
        <h2>Scenarios</h2>
      </div>
      <p className="rail-intro">
        Run real activity, then inspect its effect in the Pyric chip.
      </p>
      <div className="scenario-list">
        {scenarios.map((s) => (
          <button
            key={s.name}
            disabled={!!busy}
            onClick={() => void run(s.name, s.task)}
          >
            <span>
              <strong>{s.name}</strong>
              <small>{s.detail}</small>
            </span>
            <Icon name="play" />
          </button>
        ))}
      </div>
      {busy && (
        <button
          className="secondary"
          onClick={() => {
            cancel.current = true;
          }}
        >
          Stop {busy}
        </button>
      )}
      <p className="scenario-result" role="status">
        {busy ? `Running ${busy.toLowerCase()}…` : result}
      </p>
    </>
  );
}
function Search({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (item: Message & { channel: string }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [term, setTerm] = useState(""),
    [items, setItems] = useState<Array<Message & { channel: string }>>([]),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let valid = true;
    const timer = setTimeout(() => {
      if (term.trim())
        void searchMessages(term)
          .then((data) => {
            if (valid) setItems(data);
          })
          .catch((e) => setError(e.message));
      else setItems([]);
    }, 250);
    return () => {
      valid = false;
      clearTimeout(timer);
    };
  }, [term]);
  return (
    <dialog ref={dialog} className="search-dialog" onCancel={onClose}>
      <div className="search-input">
        <Icon name="search" />
        <input
          autoFocus
          placeholder="Search your workspace"
          aria-label="Search your workspace"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <Action name="close" label="Close search" onClick={onClose} />
      </div>
      <div className="search-results">
        {error && <p className="error">{error}</p>}
        {items.map((item) => (
          <button
            key={item.id + item.channel}
            onClick={() => {
              onSelect(item);
              onClose();
            }}
          >
            <Avatar uid={item.author} />
            <span>
              <strong>{item.text}</strong>
              <small>
                #{channels.find((c) => c.id === item.channel)?.name}
              </small>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
        {!items.length && (
          <p>
            {term
              ? "No matching messages."
              : "Find a conversation, an idea, or the feedback you need."}
          </p>
        )}
      </div>
    </dialog>
  );
}
function Workspace({ session }: { session: User }) {
  const user = session.uid;
  const notifications = useNotifications(user);
  useEffect(() => connectPresence(user), [user]);
  const [assistant, setAssistant] = useState(false);
  const [channel, setChannel] = useState(() => {
      const linked = new URLSearchParams(location.search).get("channel");
      return channels.find(item => item.id === linked)?.id ?? "design";
    }),
    [messages, setMessages] = useState<Message[]>([]),
    [error, setError] = useState(""),
    [rail, setRail] = useState<"team" | "scenarios" | "thread" | "files" | "notifications">(
      "team",
    ),
    [thread, setThread] = useState<Message>(),
    [search, setSearch] = useState(false),
    [nav, setNav] = useState(false),
    [mobileRail, setMobileRail] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearch(true);
      }
      if (event.key === "Escape") {
        setNav(false);
        setMobileRail(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const list = useRef<HTMLDivElement>(null);
  const pendingSearch = useRef<(Message & { channel: string }) | null>(null);
  const lastVisible = useRef("");
  useEffect(() => {
    const target = pendingSearch.current;
    if (target && messages.some((message) => message.id === target.id)) {
      if (target.parent) {
        setThread(messages.find((message) => message.id === target.parent));
        setRail("thread");
        setMobileRail(true);
      } else
        list.current
          ?.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`)
          ?.scrollIntoView({ block: "center" });
      pendingSearch.current = null;
      return;
    }
    const last = messages.filter((message) => !message.parent).at(-1);
    const element = list.current;
    if (last && element && last.id !== lastVisible.current) {
      if (
        last.author === user ||
        element.scrollHeight - element.scrollTop - element.clientHeight < 220
      )
        element.scrollTop = element.scrollHeight;
      lastVisible.current = last.id;
    }
  }, [messages, user]);
  const current = channels.find((c) => c.id === channel)!;
  useEffect(() => {
    setMessages([]);
    setError("");
    setThread(undefined);
    if (!list.current) return;
    return listenMessages(
      channel,
      (next) => queueMicrotask(() => flushSync(() => setMessages(next))),
      (e) => setError(e.message),
    );
  }, [channel, user]);
  function openRail(next: typeof rail) {
    setRail(next);
    setMobileRail(true);
  }
  return (
    <div className="workspace">
      <aside className={`sidebar ${nav ? "shown" : ""}`}>
        <a className="brand" href="/" aria-label="Orbit workspace">
          <span className="brand-mark">
            <span />
            <span />
          </span>
          Orbit
        </a>
        <div className="workspace-name">Studio workspace</div>
        <nav aria-label="Workspace">
          <button
            className={!assistant ? "selected" : ""}
            onClick={() => {
              setRail("team");
              setAssistant(false);
              setNav(false);
            }}
          >
            <Icon name="chat" />
            Conversations<span className="nav-count">3</span>
          </button>
          <button
            className={assistant ? "selected" : ""}
            onClick={() => {
              setAssistant(true);
              setNav(false);
            }}
          >
            <Icon name="chat" />
            AI assistant
          </button>
          <button aria-label="Notifications" onClick={() => {
            setAssistant(false);
            openRail("notifications");
            setNav(false);
          }}>
            <Icon name="bell" />Notifications
            {notifications.mentions.length > 0 && <span className="nav-count">{notifications.mentions.length}</span>}
          </button>
          <button onClick={() => setSearch(true)}>
            <Icon name="search" />
            Search<kbd>⌘ K</kbd>
          </button>
          <button
            onClick={() => {
              setAssistant(false);
              openRail("files");
              setNav(false);
            }}
          >
            <Icon name="folder" />
            Shared files
          </button>
        </nav>
        <div className="channel-section">
          <div className="section-label">
            Channels <span>{channels.length}</span>
          </div>
          {channels.map((c) => (
            <button
              className={`channel ${channel === c.id ? "active" : ""}`}
              key={c.id}
              onClick={() => {
                setAssistant(false);
                setChannel(c.id);
                setNav(false);
              }}
            >
              <i style={{ background: c.color }} /> {c.name}
              {channel === c.id && <span className="channel-dot" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="scenario-nav"
            onClick={() => {
              setAssistant(false);
              openRail("scenarios");
              setNav(false);
            }}
          >
            <Icon name="settings" />
            Demo scenarios
            <Icon name="arrow" />
          </button>
          <div className="account">
            <Avatar uid={user} />
            <div className="account-name">
              <strong>
                {session.displayName || session.email || "Member"}
              </strong>
              <small>Studio workspace</small>
            </div>
            <button
              type="button"
              className="sign-out"
              onClick={() => {
                void presence(user, "offline").catch(() => {});
                void notifications.disconnect().then(() => signOut(auth)).catch(error => {
                  setError(error instanceof Error ? error.message : "Could not sign out. Try again.");
                });
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <Assistant
        key={user}
        channel={current.name}
        messages={messages}
        visible={assistant}
        onNavigate={() => setNav(!nav)}
      />
      <main
        className="conversation"
        style={assistant ? { display: "none" } : undefined}
      >
        <header className="topbar">
          <button
            className="icon-button mobile-nav"
            aria-label="Open navigation"
            onClick={() => setNav(!nav)}
          >
            <Icon name="menu" />
          </button>
          <div>
            <h1>
              <span>#</span> {current.name}
            </h1>
            <p>{current.description}</p>
          </div>
          <div className="header-actions">
            <HeaderMembers onClick={() => openRail("team")} />
            <Action
              name="search"
              label="Search messages"
              onClick={() => setSearch(true)}
            />
          </div>
        </header>
        <div className="conversation-body" ref={list}>
          <div className="date-divider">
            <span>Today</span>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {messages
            .filter((m) => !m.parent)
            .map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                channel={channel}
                replies={messages.filter((m) => m.parent === message.id).length}
                onThread={() => {
                  setThread(message);
                  openRail("thread");
                }}
              />
            ))}
        </div>
        <footer className="conversation-footer">
          <Typing channel={channel} />
          <Composer key={channel} channel={channel} user={user} />
          <Receipts channel={channel} />
        </footer>
      </main>
      <aside
        className={`right-rail ${mobileRail ? "shown" : ""}`}
        style={assistant ? { display: "none" } : undefined}
      >
        <div className="rail-tabs">
          <button
            className={rail === "team" ? "active" : ""}
            onClick={() => setRail("team")}
          >
            Workspace
          </button>
          <button
            className={rail === "files" ? "active" : ""}
            onClick={() => setRail("files")}
          >
            Files
          </button>
          <Action
            name="close"
            label="Close side panel"
            onClick={() => setMobileRail(false)}
          />
        </div>
        {rail === "notifications" ? (
          <Notifications state={notifications} onOpen={next => {
            setChannel(next);
            setMobileRail(false);
          }} />
        ) : rail === "scenarios" ? (
          <ScenarioPanel channel={channel} user={user} />
        ) : rail === "thread" && thread ? (
          <>
            <div className="rail-heading">
              <h2>Thread</h2>
              <Action
                name="close"
                label="Close thread"
                onClick={() => setRail("team")}
              />
            </div>
            <div className="thread-messages">
              <MessageRow
                message={messages.find((m) => m.id === thread.id) ?? thread}
                channel={channel}
                replies={0}
              />
              {messages
                .filter((m) => m.parent === thread.id)
                .map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    channel={channel}
                    replies={0}
                  />
                ))}
            </div>
            <Composer channel={channel} user={user} parent={thread.id} />
          </>
        ) : rail === "files" ? (
          <>
            <div className="rail-heading">
              <h2>Shared files</h2>
            </div>
            <p className="rail-intro">Attachments in #{current.name}</p>
            {messages
              .filter((m) => m.attachment)
              .map((m) => (
                <a
                  className="attachment"
                  key={m.id}
                  href={m.attachment}
                  download={m.fileName}
                >
                  <Icon name="file" />
                  <span>
                    {m.fileName}
                    <small>
                      {workspacePeople().find((p) => p.uid === m.author)?.name}
                    </small>
                  </span>
                </a>
              ))}
            {!messages.some((m) => m.attachment) && (
              <div className="empty-files">
                <Icon name="folder" />
                <h3>A home for the details</h3>
                <p>Attach a file to a message and it will appear here.</p>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rail-heading">
              <h2>Made for the team.</h2>
            </div>
            <p className="rail-intro">A shared space for ideas in progress.</p>
            <Members />
            <div className="channel-about">
              <div className="section-label">About this channel</div>
              <p>{current.description}</p>
              <small>Created by Alice Chen</small>
            </div>
            <button
              className="scenario-link"
              onClick={() => setRail("scenarios")}
            >
              <Icon name="settings" />
              <span>Explore demo scenarios</span>
              <Icon name="arrow" />
            </button>
          </>
        )}
      </aside>
      {search && (
        <Search
          onClose={() => setSearch(false)}
          onSelect={(item) => {
            if (item.channel === channel) {
              if (item.parent) {
                setThread(
                  messages.find((message) => message.id === item.parent),
                );
                openRail("thread");
              } else
                list.current
                  ?.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)
                  ?.scrollIntoView({ block: "center" });
            } else {
              pendingSearch.current = item;
              setChannel(item.channel);
            }
          }}
        />
      )}
    </div>
  );
}
function App() {
  const [session, setSession] = useState<User | null>(null),
    [ready, setReady] = useState(false);
  useEffect(
    () =>
      onAuthStateChanged(auth, (user) => {
        setSession(user);
        setReady(true);
      }),
    [],
  );
  if (!ready)
    return (
      <div className="auth-loading" role="status">
        Loading workspace…
      </div>
    );
  return session ? (
    <Workspace key={session.uid} session={session} />
  ) : (
    <SignIn />
  );
}
export function boot() {
  createRoot(document.querySelector("#app")!).render(<App />);
}
