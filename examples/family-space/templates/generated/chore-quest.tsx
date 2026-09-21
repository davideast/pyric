import { useState, useRef, useEffect } from "react";
import { useAppData, useAppIdentity } from "@kin/app";

function Star({ filled = true, ...props }) {
  return (
    <svg {...props} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"
        fill={filled ? "#ffd166" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Button({ children, onClick, disabled = false, secondary = false }) {
  return (
    <button
      type="button"
      className={secondary ? "secondary" : "primary"}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export default function App({ family }) {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const { user, loading: identityLoading } = useAppIdentity();
  const parent = user?.role === "parent";
  const members = family?.members || [];
  const [text, setText] = useState(""),
    [assignee, setAssignee] = useState(members[0]?.id || ""),
    [filter, setFilter] = useState("open"),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(""),
    [celebration, setCelebration] = useState("");
  const [editing, setEditing] = useState(null);
  const timer = useRef(null),
    lock = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const chores = records
    .filter((r) => r.title)
    .map((r) => ({ ...r, title: String(r.title) }));
  const done = chores.filter((r) => r.completed).length,
    total = chores.length,
    progress = total ? done / total : 0;
  const visible = chores.filter((r) => filter === "all" || !r.completed);
  async function act(fn) {
    if (lock.current || loading || error || identityLoading || !user) return;
    lock.current = true;
    setBusy(true);
    setIssue("");
    try {
      await fn();
    } catch (e) {
      setIssue(e.message || String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function add() {
    if (!text.trim()) return;
    return act(async () => {
      const existing = records.find((r) => r.id === editing);
      const { id, ...kept } = existing || {};
      await setRecord(editing || crypto.randomUUID(), {
        ...kept,
        title: text.trim(),
        assigneeId: assignee,
        completed: existing?.completed ?? false,
      });
      setText("");
      setEditing(null);
    });
  }
  function complete(chore) {
    return act(async () => {
      const { id, ...data } = chore;
      await setRecord(id, { ...data, completed: !chore.completed });
      if (!chore.completed) {
        clearTimeout(timer.current);
        setCelebration(chore.title);
        timer.current = setTimeout(() => setCelebration(""), 3500);
      } else {
        clearTimeout(timer.current);
        setCelebration("");
      }
    });
  }
  return (
    <div className="quest-shell">
      <style>{`
 .quest-shell,.quest-shell *{box-sizing:border-box;margin:0}
 .quest-shell{display:grid;justify-items:center;gap:24px;color:#1e1f20}
 .quest-app{display:grid;gap:24px;width:min(100%,760px);min-width:0}
 .quest-app h2,.quest-app h3,.quest-app p{margin:0}
 .quest-header,.quest-stack{display:grid;gap:8px;min-width:0}
 .quest-hero{display:grid;gap:24px;background:#202b4b;color:white;border-radius:16px;padding:24px;overflow:hidden;position:relative}
 .quest-hero-head{display:flex;justify-content:space-between;align-items:center;gap:16px}
 .quest-hero h2{font-size:clamp(24px,5vw,36px);color:white}
 .quest-muted{color:#69727e}.quest-hero p{color:#d5dff6}
 .quest-score{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:20px;font-weight:700}
 .quest-score svg{width:28px;height:28px;color:#ffd166}
 .quest-track{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));align-items:center;gap:8px}
 .quest-stop{display:grid;justify-items:center;align-items:center;gap:8px;min-width:0;font-size:12px;color:#d5dff6}
 .quest-stop span{min-height:32px;text-align:center}
 .quest-stop svg{width:clamp(26px,7vw,48px);height:clamp(26px,7vw,48px);color:#ffd166;transition:transform .25s}
 .quest-stop[data-earned="true"] svg{transform:rotate(-8deg)}
 .quest-meter{width:100%;height:10px;appearance:none;border:0;border-radius:8px;overflow:hidden;background:#3c4869}
 .quest-meter::-webkit-progress-bar{background:#3c4869}.quest-meter::-webkit-progress-value{background:#ffd166}.quest-meter::-moz-progress-bar{background:#ffd166}
 .quest-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
 .quest-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .quest-app button{min-height:44px;padding:10px 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px}
 .quest-list{display:grid;gap:12px;list-style:none;padding:0}
 .quest-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;padding:16px;background:white;border:1px solid #e7eaee;border-radius:12px;min-width:0}
 .quest-card label{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center;gap:12px;min-width:0;cursor:pointer}
 .quest-card input[type=checkbox]{width:24px;height:24px;padding:0;accent-color:#0659fd}
 .quest-title{display:block;max-width:38ch;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:700}
 .quest-card[data-done=true] .quest-title{text-decoration:line-through;color:#69727e}
 .quest-card small{color:#69727e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .quest-delete{width:44px;color:#69727e;background:#edf1f6;border:0;border-radius:10px}
 .quest-delete svg{width:18px;height:18px}
 .quest-form{display:grid;gap:16px;padding:20px;background:white;border:1px solid #e7eaee;border-radius:12px}
 .quest-fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:end;gap:12px}
 .quest-field{display:grid;gap:8px;min-width:0}
 .quest-field input,.quest-field select{width:100%;min-width:0;min-height:44px;padding:12px;border:1px solid #d5dbe5;border-radius:10px;background:white}
 .quest-team{display:flex;gap:12px;flex-wrap:wrap}
 .quest-member{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#edf1f6;border-radius:10px;max-width:100%}
 .quest-member span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .quest-member svg{width:20px;height:20px;flex-shrink:0;color:#876523}
 .quest-empty{display:grid;justify-items:start;gap:12px;padding:20px;background:#edf2ff;border-radius:12px}
 .quest-celebration{display:flex;align-items:center;gap:12px;padding:16px;background:#fff1cb;border-radius:12px;position:relative;overflow:hidden}
 .quest-celebration>svg{width:40px;height:40px;flex-shrink:0;color:#876523}
 .quest-sparks{position:absolute;inset:0;pointer-events:none;overflow:hidden}
 .quest-sparks svg{position:absolute;width:16px;height:16px;left:50%;top:50%;animation:quest-burst 1.8s ease-out both;color:#876523}
 @keyframes quest-burst{from{transform:translate(0,0) scale(.4);opacity:1}to{transform:translate(var(--x),var(--y)) rotate(160deg);opacity:0}}
 @media(max-width:480px){.quest-fields{grid-template-columns:minmax(0,1fr)}.quest-hero{padding:20px}.quest-hero-head{flex-wrap:wrap}}
 @media(prefers-reduced-motion:reduce){.quest-sparks{display:none}.quest-stop svg{transition:none}}
 `}</style>
      <main className="quest-app">
        <header className="quest-header">
          <h2>Chore Quest</h2>
          <p className="quest-muted">
            Little quests. A happier home. One mighty family team.
          </p>
        </header>
        <section className="quest-hero" aria-label="Family quest progress">
          <div className="quest-hero-head">
            <div className="quest-stack">
              <p>Your family adventure</p>
              <h2>
                {total && done === total
                  ? "Household heroes!"
                  : done
                    ? "The team is on a roll"
                    : "Ready, set, quest!"}
              </h2>
            </div>
            <div className="quest-score">
              <Star />
              {done * 10} stars
            </div>
          </div>
          <div className="quest-track">
            {["Start", "Pitch in", "Teamwork", "Home stretch", "Heroes"].map(
              (label, i) => (
                <div
                  key={label}
                  className="quest-stop"
                  data-earned={total > 0 && progress >= i / 4}
                >
                  <Star filled={total > 0 && progress >= i / 4} />
                  <span>{label}</span>
                </div>
              ),
            )}
          </div>
          <progress
            className="quest-meter"
            max={total || 1}
            value={done}
            aria-label="Completed quests"
          />
          <p>
            {done} of {total} quests complete · Each finished chore earns 10
            stars.
          </p>
        </section>
        {(error || issue) && <p role="alert">{error || issue}</p>}
        {celebration && (
          <div className="quest-celebration" role="status">
            <Star />
            <div className="quest-stack">
              <strong>Quest complete! +10 stars</strong>
              <span className="quest-title" title={celebration}>
                {celebration}
              </span>
            </div>
            <div className="quest-sparks" aria-hidden="true">
              {Array.from({ length: 18 }, (_, i) => (
                <Star
                  key={i}
                  style={{
                    "--x": ((i * 47) % 500) - 250 + "px",
                    "--y": ((i * 31) % 160) - 80 + "px",
                  }}
                />
              ))}
            </div>
          </div>
        )}
        <section className="quest-stack" aria-label="Family team">
          <h3>Your quest crew</h3>
          <div className="quest-team">
            {members.map((m) => (
              <div key={m.id} className="quest-member">
                <Star />
                <span>{m.name}</span>
                <strong>
                  {chores.filter((c) => c.completed && c.assigneeId === m.id)
                    .length * 10}
                </strong>
              </div>
            ))}
          </div>
        </section>
        <section className="quest-stack">
          <div className="quest-toolbar">
            <h3>Quest board</h3>
            <div className="quest-actions">
              <Button
                secondary={filter !== "open"}
                onClick={() => setFilter("open")}
              >
                Open ({total - done})
              </Button>
              <Button
                secondary={filter !== "all"}
                onClick={() => setFilter("all")}
              >
                All ({total})
              </Button>
            </div>
          </div>
          {loading ? (
            <p role="status">Loading quests…</p>
          ) : visible.length ? (
            <ul className="quest-list">
              {visible.map((c) => (
                <li className="quest-card" data-done={!!c.completed} key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!c.completed}
                      disabled={
                        busy ||
                        !!error ||
                        !user ||
                        (!parent && c.assigneeId !== user.uid)
                      }
                      aria-label={c.title}
                      onChange={() => complete(c)}
                    />
                    <span className="quest-stack">
                      <span className="quest-title" title={c.title}>
                        {c.title}
                      </span>
                      <small>
                        {members.find((m) => m.id === c.assigneeId)?.name ||
                          "Family team"}{" "}
                        · 10 stars
                      </small>
                    </span>
                  </label>
                  {parent && (
                    <div className="quest-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditing(c.id);
                          setText(c.title);
                          setAssignee(c.assigneeId);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="quest-delete"
                        disabled={busy || !!error}
                        aria-label={"Delete " + c.title}
                        onClick={() => act(() => deleteRecord(c.id))}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="m6 6 12 12M18 6 6 18"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="quest-empty">
              <strong>
                {total
                  ? "Every quest conquered. Time to enjoy your home!"
                  : "Your first quest starts here."}
              </strong>
              <p>
                {total
                  ? "Add another task whenever your team is ready."
                  : "Add a chore below or try a few starter quests."}
              </p>
              {!total && parent && (
                <Button
                  secondary
                  disabled={busy || !!error}
                  onClick={() =>
                    act(async () => {
                      for (const [i, title] of [
                        "Water the plants",
                        "Feed the pets",
                        "Take out recycling",
                      ].entries())
                        await setRecord(crypto.randomUUID(), {
                          title,
                          assigneeId:
                            members[i % Math.max(1, members.length)]?.id || "",
                          completed: false,
                        });
                    })
                  }
                >
                  Add sample chores
                </Button>
              )}
            </div>
          )}
        </section>
        {parent && (
          <form
            className="quest-form"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.target.tagName === "INPUT") {
                e.preventDefault();
                void add();
              }
            }}
          >
            <h3>{editing ? "Edit quest" : "Create a quest"}</h3>
            <div className="quest-fields">
              <label className="quest-field" htmlFor="quest-title">
                Chore
                <input
                  id="quest-title"
                  value={text}
                  maxLength={160}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Give the plants a drink"
                />
              </label>
              <label className="quest-field" htmlFor="quest-assignee">
                Assign to
                <select
                  id="quest-assignee"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="quest-actions">
              <Button
                disabled={busy || loading || !!error || !text.trim()}
                onClick={add}
              >
                {editing ? "Save chore" : "Add chore"}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
