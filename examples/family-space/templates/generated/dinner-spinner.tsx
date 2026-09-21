import { useState, useRef, useEffect } from "react";
import { useAppData } from "@kin/app";

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: "grid", gap: 24, minWidth: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {description && (
            <p style={{ margin: 0, color: "#69727e", maxWidth: "65ch" }}>
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {actions}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

function Button({
  children,
  variant = "primary",
  busy = false,
  disabled = false,
  type = "button",
  ...props
}) {
  return (
    <button
      {...props}
      type={type === "submit" ? "button" : type}
      onClick={(event) => {
        if (type === "submit") {
          event.preventDefault();
          const form = event.currentTarget.form;
          if (form?.reportValidity())
            form.dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            );
        } else props.onClick?.(event);
      }}
      className={variant === "primary" ? "primary" : "secondary"}
      disabled={disabled || busy}
      aria-busy={busy}
      style={{ minHeight: 44, padding: "11px 19px" }}
    >
      {children}
    </button>
  );
}

function Field({ id, label, value, onChange, hint, error, ...props }) {
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error || hint ? id + "-help" : undefined}
        style={{
          width: "100%",
          minWidth: 0,
          padding: 12,
          border: "1px solid #e7eaee",
          borderRadius: 10,
        }}
      />
      {(error || hint) && (
        <p
          id={id + "-help"}
          role={error ? "alert" : undefined}
          style={{ margin: 0, color: error ? "#9e302b" : "#69727e" }}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

function CardList({ items, renderItem, empty = "Nothing here yet." }) {
  return (
    <div className="surface" style={{ padding: 20, minWidth: 0 }}>
      {items.length ? (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 16,
          }}
        >
          {items.map((item) => (
            <li key={item.id} style={{ minWidth: 0 }}>
              {renderItem(item)}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, color: "#69727e" }}>{empty}</p>
      )}
    </div>
  );
}

function Feedback({ kind = "empty", title, children, actions }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{
        display: "grid",
        gap: 12,
        padding: "20px 0",
        borderTop: "1px solid #e7eaee",
        minWidth: 0,
      }}
    >
      <strong>{title}</strong>
      {children && (
        <div style={{ color: "#69727e", lineHeight: 1.6 }}>{children}</div>
      )}
      {actions && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {actions}
        </div>
      )}
    </div>
  );
}

const wheelColors = [
  "#0659fd",
  "#bdebdc",
  "#ffbf85",
  "#cebfff",
  "#ffe08a",
  "#f5adc3",
];
function DinnerWheel({ options, disabled, onPick }) {
  const disk = useRef(null),
    animation = useRef(null),
    timer = useRef(null),
    mounted = useRef(true),
    angle = useRef(0),
    locked = useRef(false);
  const [spinning, setSpinning] = useState(false),
    [frozen, setFrozen] = useState(null),
    [winner, setWinner] = useState(""),
    [burst, setBurst] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      animation.current?.cancel();
      clearTimeout(timer.current);
    };
  }, []);
  const choices = frozen || options;
  async function spin() {
    if (locked.current || disabled || !options.length) return;
    locked.current = true;
    setSpinning(true);
    setWinner("");
    setBurst(0);
    const snapshot = options.slice();
    setFrozen(snapshot);
    const index = Math.floor(Math.random() * snapshot.length),
      step = 360 / snapshot.length;
    const landing = (360 - (index + 0.5) * step) % 360;
    const next =
      angle.current + 360 * 7 + ((landing - (angle.current % 360) + 360) % 360);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      animation.current = disk.current.animate(
        [
          { transform: "rotate(" + angle.current + "deg)" },
          { transform: "rotate(" + next + "deg)" },
        ],
        {
          duration: reduced ? 120 : 5600,
          easing: "cubic-bezier(0.12, 0.7, 0.12, 1)",
          fill: "forwards",
        },
      );
      await animation.current.finished;
      if (!mounted.current) return;
      angle.current = next;
      disk.current.style.transform = "rotate(" + next + "deg)";
      animation.current.cancel();
      setWinner(snapshot[index].name);
      if (!reduced) {
        setBurst(Date.now());
        timer.current = setTimeout(() => setBurst(0), 3200);
      }
      await onPick(snapshot[index]);
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally {
      locked.current = false;
      if (mounted.current) {
        setSpinning(false);
      }
    }
  }
  // Keep the winning slice under the pointer until the shortlist changes.
  useEffect(() => {
    if (!spinning) {
      setFrozen(null);
    }
  }, [options.map((o) => o.id + o.name).join("|")]);
  const point = (degrees, r = 196) => [
    220 + Math.sin((degrees * Math.PI) / 180) * r,
    220 - Math.cos((degrees * Math.PI) / 180) * r,
  ];
  return (
    <section className="dinner-stage" aria-label="Dinner wheel">
      <style>{`
 .dinner-stage{position:relative;display:grid;justify-items:center;gap:24px;padding:28px 12px;background:#edf2ff;border-radius:16px}
 .dinner-wheel{position:relative;width:min(100%,460px);aspect-ratio:1;overflow:hidden}
 .dinner-wheel svg{display:block;width:100%;height:100%;overflow:hidden}
 .dinner-pointer{position:absolute;z-index:2;top:0;left:50%;transform:translateX(-50%);width:32px;height:40px;background:#1e1f20;clip-path:polygon(0 0,100% 0,50% 100%)}
 .dinner-outcome{text-align:center;display:grid;gap:8px;min-height:76px;max-width:100%;overflow-wrap:anywhere}
 .dinner-outcome p,.dinner-outcome h2{margin:0}
 .dinner-confetti{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:100}
 .dinner-confetti i{position:absolute;left:50%;top:48%;width:9px;height:15px;background:var(--color);animation:dinner-pop 3s cubic-bezier(.1,.6,.25,1) both}
 @keyframes dinner-pop{0%{transform:translate(0,0) rotate(0);opacity:1}65%{opacity:1}100%{transform:translate(var(--x),var(--y)) rotate(var(--turn));opacity:0}}
 @media(prefers-reduced-motion:reduce){.dinner-confetti{display:none}}
 `}</style>
      <div className="dinner-wheel">
        <div className="dinner-pointer" aria-hidden="true" />
        <svg
          ref={disk}
          viewBox="0 0 440 440"
          role="img"
          aria-label={
            choices.length
              ? "Dinner options: " + choices.map((o) => o.name).join(", ")
              : "Add dinners to fill the wheel"
          }
        >
          <circle cx="220" cy="220" r="214" fill="#1e1f20" />
          {choices.length ? (
            choices.map((o, i) => {
              const step = 360 / choices.length,
                a = point(i * step),
                b = point((i + 1) * step);
              return (
                <g key={o.id}>
                  {choices.length === 1 ? (
                    <circle cx="220" cy="220" r="196" fill={wheelColors[0]} />
                  ) : (
                    <path
                      d={`M220 220 L${a[0]} ${a[1]} A196 196 0 ${step > 180 ? 1 : 0} 1 ${b[0]} ${b[1]} Z`}
                      fill={wheelColors[i % wheelColors.length]}
                      stroke="#fff"
                      strokeWidth="2"
                    />
                  )}
                  <g transform={`rotate(${(i + 0.5) * step} 220 220)`}>
                    <text
                      x="220"
                      y="65"
                      textAnchor="middle"
                      fill={i % wheelColors.length === 0 ? "white" : "#1e1f20"}
                      fontSize={choices.length > 12 ? 10 : 14}
                      fontWeight="700"
                    >
                      <title>{o.name}</title>
                      {o.name.length > 19 ? o.name.slice(0, 17) + "…" : o.name}
                    </text>
                  </g>
                </g>
              );
            })
          ) : (
            <circle cx="220" cy="220" r="196" fill="#dbe5fc" />
          )}
          {Array.from({ length: 36 }, (_, i) => {
            const [x, y] = point(i * 10, 205);
            return <circle key={i} cx={x} cy={y} r="3" fill="#ffe08a" />;
          })}
          <circle cx="220" cy="220" r="35" fill="white" />
          <circle cx="220" cy="220" r="12" fill="#0659fd" />
        </svg>
      </div>
      <div className="dinner-outcome" role="status" aria-live="polite">
        <p>
          {spinning
            ? "Round and round…"
            : winner
              ? "Tonight’s winner"
              : "Dinner is up for a spin"}
        </p>
        <h2>
          {spinning ? "Where will it land?" : winner || "Let the wheel decide"}
        </h2>
      </div>
      <Button disabled={disabled || spinning || !options.length} onClick={spin}>
        {spinning ? "Spinning…" : "Spin dinner"}
      </Button>
      <p style={{ margin: 0, color: "#334052", textAlign: "center" }}>
        {options.length
          ? options.length + " dinners. One delicious decision."
          : "Add your favorite dinners below to fill the wheel."}
      </p>
      {burst > 0 && (
        <div key={burst} className="dinner-confetti" aria-hidden="true">
          {Array.from({ length: 64 }, (_, i) => (
            <i
              key={i}
              style={{
                "--x": ((i * 137) % 110) - 55 + "vw",
                "--y": ((i * 73) % 140) - 85 + "vh",
                "--turn": i * 83 + "deg",
                "--color": wheelColors[i % wheelColors.length],
                animationDelay: (i % 8) * 0.018 + "s",
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  const legacy = records.find((r) => r.id === "restaurant_options");
  const options = records
    .filter((r) => r.id.startsWith("opt-") || r.id.startsWith("option-"))
    .map((r) => ({
      id: r.id,
      name: String(r.name || "Dinner option"),
      enabled: r.enabled ?? r.active ?? true,
    }));
  if (Array.isArray(legacy?.options))
    legacy.options.forEach((v, i) => {
      if (v != null)
        options.push({
          id: "legacy-" + i,
          name: typeof v === "string" ? v : String(v.name || "Dinner option"),
          enabled:
            typeof v === "object" ? (v.enabled ?? v.active ?? true) : true,
          index: i,
        });
    });
  const enabled = options.filter((o) => o.enabled);
  const latest = records
    .filter((r) => r.id.startsWith("result-"))
    .sort((a, b) => String(b.spunAt).localeCompare(String(a.spunAt)))[0];
  async function act(fn) {
    if (busy || loading || error) return;
    setBusy(true);
    setIssue("");
    try {
      await fn();
    } catch (e) {
      setIssue(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function change(option, remove) {
    if (option.index !== undefined) {
      const values = legacy.options.flatMap((v, i) =>
        i !== option.index
          ? [v]
          : remove
            ? []
            : [{ name: option.name, enabled: !option.enabled }],
      );
      const { id, ...data } = legacy;
      await setRecord(id, { ...data, options: values });
    } else if (remove) await deleteRecord(option.id);
    else {
      const { id, ...data } = records.find((r) => r.id === option.id);
      await setRecord(id, {
        ...data,
        enabled: !option.enabled,
        active: !option.enabled,
      });
    }
  }
  return (
    <main
      style={{
        padding: 24,
        maxWidth: 760,
        margin: "0 auto",
        display: "grid",
        gap: 28,
      }}
    >
      <Section
        title="Dinner Spinner"
        description="A shortlist everyone can agree on. Let chance make tonight’s final call."
      />
      {(error || issue) && (
        <Feedback kind="error" title="Could not save">
          {error || issue}
        </Feedback>
      )}
      {loading ? (
        <Feedback title="Loading dinners…" />
      ) : (
        <>
          <DinnerWheel
            options={enabled}
            disabled={busy || !!error}
            onPick={(chosen) =>
              act(() =>
                setRecord("result-" + crypto.randomUUID(), {
                  chosen: chosen.name,
                  spunAt: new Date().toISOString(),
                }),
              )
            }
          />
          {latest && (
            <p style={{ margin: 0, color: "#69727e" }}>
              Last saved pick: <strong>{latest.chosen}</strong>
            </p>
          )}
          <Section title="Your dinner shortlist">
            {!options.length && (
              <Feedback
                title="Start with your favorites"
                actions={
                  <Button
                    variant="secondary"
                    disabled={busy || !!error}
                    onClick={() =>
                      act(async () => {
                        for (const name of [
                          "Taco night",
                          "Homemade pizza",
                          "Pasta and salad",
                        ])
                          await setRecord("option-" + crypto.randomUUID(), {
                            name,
                            enabled: true,
                          });
                      })
                    }
                  >
                    Add sample dinners
                  </Button>
                }
              >
                These are sample home meals. Add your own meals or restaurants
                below.
              </Feedback>
            )}
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "grid",
                gap: 12,
              }}
            >
              {options.map((o) => (
                <li
                  key={o.id}
                  className="dinner-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    alignItems: "center",
                    justifyContent: "space-between",
                    minHeight: 64,
                    gap: 16,
                    borderBottom: "1px solid #e7eaee",
                  }}
                >
                  <label
                    style={{
                      display: "grid",
                      gridTemplateColumns: "20px minmax(0, 1fr)",
                      alignItems: "center",
                      gap: 12,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{
                        width: 20,
                        height: 20,
                        flexShrink: 0,
                        margin: 0,
                      }}
                      checked={!!o.enabled}
                      disabled={busy || !!error}
                      onChange={() => act(() => change(o, false))}
                    />
                    <span
                      title={o.name}
                      style={{
                        minWidth: 0,
                        maxWidth: "32ch",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.name}
                    </span>
                  </label>
                  <Button
                    variant="secondary"
                    disabled={busy || !!error}
                    aria-label={"Remove " + o.name}
                    onClick={() => act(() => change(o, true))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <form
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target.tagName === "INPUT") {
                  event.preventDefault();
                  if (event.currentTarget.reportValidity())
                    event.currentTarget.dispatchEvent(
                      new Event("submit", { bubbles: true, cancelable: true }),
                    );
                }
              }}
              style={{ display: "grid", gap: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim())
                  void act(async () => {
                    await setRecord("option-" + crypto.randomUUID(), {
                      name: name.trim(),
                      enabled: true,
                    });
                    setName("");
                  });
              }}
            >
              <Field
                id="dinner-option"
                label="Dinner option"
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your favorite meal or restaurant"
              />
              <div>
                <Button
                  type="submit"
                  disabled={busy || !name.trim() || !!error}
                >
                  Add dinner
                </Button>
              </div>
            </form>
          </Section>
        </>
      )}
    </main>
  );
}
