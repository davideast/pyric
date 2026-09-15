import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Message } from "./data";
import {
  channelContext,
  streamAssistant,
  type AssistantTurn,
} from "./assistant-api";
import "./assistant.css";

type Chat = {
  id: string;
  title: string;
  channel: string;
  context: string;
  turns: AssistantTurn[];
};
const suggestions = [
  {
    title: "Catch up on this channel",
    detail: "A short summary of the conversation",
    icon: "chat",
    prompt:
      "Summarize this channel's recent discussion in a few concise bullets.",
  },
  {
    title: "Find the next steps",
    detail: "Action items, owners, and open questions",
    icon: "check",
    prompt:
      "List the explicit action items and their owners, followed by unresolved questions. Mark missing owners or deadlines as unspecified.",
  },
  {
    title: "Draft a thoughtful reply",
    detail: "Turn the conversation into a useful response",
    icon: "send",
    prompt:
      "Draft a brief, friendly reply to the latest discussion. Acknowledge the main points and suggest a useful next step without inventing commitments.",
  },
];

export function Assistant({
  channel,
  messages,
  visible,
  onNavigate,
}: {
  channel: string;
  messages: Message[];
  visible: boolean;
  onNavigate: () => void;
}) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<number>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const active = chats.find((chat) => chat.id === selected);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240)
      el.scrollTop = el.scrollHeight;
  }, [chats]);
  useEffect(() => {
    const dialog = historyDialog.current;
    if (historyOpen && visible) dialog?.showModal();
    else dialog?.close();
  }, [historyOpen, visible]);
  async function ask(question: string, regenerate = false) {
    if (lock.current || !question.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setCopied(undefined);
    setPrompt("");
    const chat = active ?? {
      id: crypto.randomUUID(),
      title: question.slice(0, 64),
      channel,
      context: channelContext(channel, messages),
      turns: [],
    };
    const previous = regenerate ? chat.turns.slice(0, -2) : chat.turns;
    const turns: AssistantTurn[] = [
      ...previous,
      { role: "user", text: question.trim() },
    ];
    const next = {
      ...chat,
      turns: [...turns, { role: "model" as const, text: "" }],
    };
    setSelected(chat.id);
    setChats((all) =>
      active
        ? all.map((item) => (item.id === chat.id ? next : item))
        : [next, ...all],
    );
    const update = (text: string) => {
      if (mounted.current)
        setChats((all) =>
          all.map((item) =>
            item.id === chat.id
              ? { ...item, turns: [...turns, { role: "model", text }] }
              : item,
          ),
        );
    };
    try {
      await streamAssistant(chat.context, turns, update);
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "Unable to get an answer. Try again.",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function newChat() {
    setSelected(undefined);
    setPrompt("");
    setError("");
    setHistoryOpen(false);
  }
  const retryPrompt = active?.turns.at(-2)?.text;
  const history = (
    <>
      <div className="assistant-history-heading">
        <h2>Chat history</h2>
        <button
          className="assistant-history-close"
          onClick={() => setHistoryOpen(false)}
          aria-label="Close chat history"
        >
          <Icon name="close" />
        </button>
      </div>
      <p>Saved for this visit</p>
      <div className="assistant-chat-list">
        {chats.length ? (
          chats.map((chat) => (
            <button
              className={selected === chat.id ? "selected" : ""}
              key={chat.id}
              disabled={busy}
              onClick={() => {
                setSelected(chat.id);
                setError("");
                setHistoryOpen(false);
              }}
            >
              <strong>{chat.title}</strong>
              <small>#{chat.channel}</small>
            </button>
          ))
        ) : (
          <p>Your conversations with Orbit will appear here.</p>
        )}
      </div>
      <button className="assistant-new" disabled={busy} onClick={newChat}>
        <Icon name="plus" /> New chat
      </button>
    </>
  );
  return (
    <section
      className="assistant-workspace"
      hidden={!visible}
      aria-label="Orbit assistant"
    >
      <main className="assistant-main">
        <header className="topbar assistant-topbar">
          <button
            className="icon-button mobile-nav"
            aria-label="Open navigation"
            onClick={onNavigate}
          >
            <Icon name="menu" />
          </button>
          <div>
            <h1>{active?.title || "Orbit assistant"}</h1>
            <p>Channel context: #{active?.channel || channel}</p>
          </div>
          <button
            className="assistant-history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            Chats
          </button>
        </header>
        <div className="assistant-scroll" ref={scroll}>
          {!active ? (
            <div className="assistant-welcome">
              <h2>A little help for your next big idea.</h2>
              <p>Catch up, find clarity, and move the work forward.</p>
              <div className="assistant-suggestions">
                {suggestions.map((item, index) => (
                  <button
                    key={item.title}
                    disabled={busy || messages.length === 0}
                    onClick={() => void ask(item.prompt)}
                  >
                    <span className={`assistant-suggestion-icon tone-${index}`}>
                      <Icon name={item.icon} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                ))}
              </div>
              <p className="assistant-context-note">
                Uses up to 40 recent messages from #{channel}. Attachments are
                not included.
              </p>
            </div>
          ) : (
            <div className="assistant-turns">
              {active.turns.map((turn, index) => (
                <article className={`assistant-turn ${turn.role}`} key={index}>
                  <div className="assistant-speaker">
                    {turn.role === "user" ? "You" : "Orbit"}
                  </div>
                  <div className="assistant-answer">
                    {turn.text ||
                      (busy
                        ? "Thinking about your question…"
                        : "No response yet.")}
                  </div>
                  {turn.role === "model" && turn.text && !busy && (
                    <div className="assistant-answer-actions">
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(turn.text);
                            setCopied(index);
                          } catch {
                            setError(
                              "Copy is unavailable here. Select the answer to copy it.",
                            );
                          }
                        }}
                      >
                        {copied === index ? "Copied" : "Copy"}
                      </button>
                      {index === active.turns.length - 1 && (
                        <button
                          onClick={() =>
                            void ask(active.turns[index - 1].text, true)
                          }
                        >
                          Regenerate
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          <div role="status" className="assistant-status">
            {busy ? "Generating answer…" : ""}
          </div>
          {error && (
            <div className="assistant-error" role="alert">
              <p>{error}</p>
              {retryPrompt && (
                <button
                  disabled={busy}
                  onClick={() => void ask(retryPrompt, true)}
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
        <form
          className="assistant-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(prompt);
          }}
        >
          <label className="sr-only" htmlFor="assistant-prompt">
            Ask Orbit
          </label>
          <textarea
            id="assistant-prompt"
            placeholder="Ask about the conversation…"
            value={prompt}
            maxLength={4000}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!busy) void ask(prompt);
              }
            }}
          />
          <button
            className="assistant-send"
            type="submit"
            disabled={busy || !prompt.trim()}
            aria-label="Send question"
          >
            <Icon name="send" />
          </button>
        </form>
        <p className="assistant-footnote">
          Review answers before sharing them with your team.
        </p>
      </main>
      <aside
        className="assistant-history desktop-history"
        aria-label="Assistant chat history"
      >
        {history}
      </aside>
      <dialog
        ref={historyDialog}
        className="assistant-history-dialog"
        aria-label="Assistant chat history"
        onClose={() => setHistoryOpen(false)}
      >
        <div className="assistant-history">{history}</div>
      </dialog>
    </section>
  );
}
