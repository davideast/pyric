import React, { useEffect, useRef, useState } from "react";
import { collection, doc, deleteDoc, updateDoc } from "firebase/firestore";
import {
  db,
  base,
  watchList,
  sendChat,
  type ChatMessage,
  type Member,
} from "./data";
import { Avatar, Media, ErrorNotice, Icon, clock } from "./ui";
export function FamilyChat({
  member,
  members,
}: {
  member: Member;
  members: Member[];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [text, setText] = useState(""),
    [file, setFile] = useState<File | Blob>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false),
    [editing, setEditing] = useState("");
  const recorder = useRef<MediaRecorder | undefined>(undefined),
    stream = useRef<MediaStream | undefined>(undefined),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    alive = useRef(true),
    list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    const stop = watchList<ChatMessage>(
      collection(db, `${base}/chat`),
      setMessages,
      (e) => setError(e.message),
    );
    return () => {
      alive.current = false;
      stop();
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 250)
      el.scrollTop = el.scrollHeight;
  }, [messages]);
  async function act(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not save your message. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    setError("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Voice recording needs a secure browser connection. You can attach an audio file instead.",
        );
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        audio.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = audio;
      const media = new MediaRecorder(audio);
      recorder.current = media;
      const chunks: Blob[] = [];
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      media.onstop = () => {
        clearTimeout(timer.current);
        audio.getTracks().forEach((t) => t.stop());
        if (alive.current) {
          setFile(new Blob(chunks, { type: media.mimeType }));
          setRecording(false);
        }
      };
      media.start();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (media.state === "recording") media.stop();
      }, 60000);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Microphone access was not available.",
      );
    }
  }
  return (
    <section className="chat-view">
      <header className="chat-header">
        <div className="chat-family-avatars">
          {members.map((m) => (
            <Avatar key={m.id} member={m} />
          ))}
        </div>
        <div>
          <h1>Our family chat</h1>
          <p>A little space for the everyday.</p>
        </div>
      </header>
      <div className="chat-sheet">
        <div className="chat-messages" ref={list}>
          <p className="chat-intro">Just the {members.length} of us</p>
          {messages
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((m) => (
              <ChatMessageRow
                key={m.id}
                m={m}
                member={member}
                members={members}
                busy={busy}
                onEdit={() => {
                  setEditing(m.id);
                  setText(m.text);
                  setFile(undefined);
                }}
                onDelete={() =>
                  void act(() => deleteDoc(doc(db, `${base}/chat/${m.id}`)))
                }
              />
            ))}
        </div>
        <div className="chat-bottom">
          <ErrorNotice message={error} />
          {editing && (
            <p className="attachment-note">
              Editing message{" "}
              <button
                onClick={() => {
                  setEditing("");
                  setText("");
                }}
              >
                Cancel
              </button>
            </p>
          )}
          {file && (
            <p className="attachment-note">
              {file instanceof File ? file.name : "Voice message ready"}
              <button onClick={() => setFile(undefined)}>Remove</button>
            </p>
          )}
          {recording && (
            <p className="recording-status" role="status">
              Recording your voice…{" "}
              <button onClick={() => recorder.current?.stop()}>
                Stop recording
              </button>
            </p>
          )}
          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              if (recording || (!text.trim() && !file)) return;
              void act(async () => {
                if (editing)
                  await updateDoc(doc(db, `${base}/chat/${editing}`), {
                    text: text.trim(),
                  });
                else await sendChat(member.id, text, file);
                setText("");
                setFile(undefined);
                setEditing("");
              });
            }}
          >
            <label
              className="attach-button"
              title="Attach photo, video, or audio"
            >
              <Icon name="plus" />
              <input
                aria-label="Attach photo, video, or audio"
                type="file"
                accept="image/*,video/*,audio/*"
                disabled={busy || recording || !!editing}
                onChange={(e) => {
                  setFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <input
              aria-label="Family chat message"
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              placeholder="A thought, a photo, a little hello…"
            />
            <button
              className="voice-button"
              type="button"
              disabled={busy || recording || !!editing}
              onClick={() => void record()}
            >
              Voice
            </button>
            <button
              className="primary"
              disabled={busy || recording || (!text.trim() && !file)}
            >
              {busy ? "Sending…" : editing ? "Save" : "Send"}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function ChatMessageRow({
  m,
  member,
  members,
  busy,
  onEdit,
  onDelete,
}: {
  m: ChatMessage;
  member: Member;
  members: Member[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className={`chat-message ${m.authorId === member.id ? "own" : ""}`}
    >
      <Avatar member={members.find((u) => u.id === m.authorId)} />
      <div className="chat-message-content">
        <div className="comment-name">
          <strong>
            {members.find((u) => u.id === m.authorId)?.name.split(" ")[0] ??
              "Family member"}
          </strong>
          <small>{clock(m.createdAt)}</small>
        </div>
        {m.text && <p>{m.text}</p>}
        {m.mediaPath && (
          <Media
            path={m.mediaPath}
            kind={m.mediaType}
            alt={`${m.mediaType} from ${members.find((u) => u.id === m.authorId)?.name ?? "family"}`}
          />
        )}{" "}
        {(m.authorId === member.id || member.role === "parent") && (
          <div className="comment-actions">
            <button onClick={onEdit}>Edit</button>
            <button disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
