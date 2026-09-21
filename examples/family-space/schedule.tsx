import React, { useState } from "react";
import type { Post } from "./data";
import { Icon, Empty, clock, navigate } from "./ui";
const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function Schedule({
  posts,
  parent,
}: {
  posts: Post[];
  parent: boolean;
}) {
  const [mode, setMode] = useState<"day" | "week" | "month">("week"),
    [date, setDate] = useState(dateKey(new Date()));
  const selected = new Date(date + "T12:00:00");
  const events = posts
    .filter((p) => p.kind === "event" && p.status === "published" && p.eventAt)
    .sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const start = new Date(selected);
  if (mode === "week")
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (mode === "month") {
    start.setDate(1);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  }
  const days = Array.from(
    { length: mode === "day" ? 1 : mode === "week" ? 7 : 42 },
    (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    },
  );
  function move(step: number) {
    const d = new Date(selected);
    if (mode === "month") {
      d.setDate(1);
      d.setMonth(d.getMonth() + step);
    } else d.setDate(d.getDate() + step * (mode === "week" ? 7 : 1));
    setDate(dateKey(d));
  }
  const visible = events.filter((p) =>
    days.some((d) => p.eventAt.startsWith(dateKey(d))),
  );
  return (
    <section className="schedule">
      <div className="schedule-toolbar">
        <div className="segmented">
          {(["day", "week", "month"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        {parent && (
          <button className="primary" onClick={() => navigate("compose/event")}>
            <Icon name="plus" />
            New event
          </button>
        )}
      </div>
      <div className="calendar-heading">
        <button
          className="icon-button"
          aria-label="Previous period"
          onClick={() => move(-1)}
        >
          <Icon name="back" />
        </button>
        <h2>
          {selected.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <button
          className="icon-button"
          aria-label="Next period"
          onClick={() => move(1)}
        >
          <Icon name="right" />
        </button>
        <button
          className="text-link"
          onClick={() => setDate(dateKey(new Date()))}
        >
          Today
        </button>
        <label className="sr-only" htmlFor="calendar-date">
          Choose date
        </label>
        <input
          id="calendar-date"
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value) setDate(e.target.value);
          }}
        />
      </div>
      <div className={`calendar ${mode}`}>
        <div className="calendar-grid">
          {days.map((day) => {
            const key = dateKey(day),
              items = events.filter((p) => p.eventAt.startsWith(key));
            return (
              <div
                className={`calendar-cell ${day.getMonth() !== selected.getMonth() ? "outside" : ""} ${key === dateKey(new Date()) ? "today" : ""}`}
                key={key}
              >
                <button
                  className="calendar-day"
                  aria-label={day.toLocaleDateString(undefined, {
                    dateStyle: "full",
                  })}
                  onClick={() => {
                    setDate(key);
                    setMode("day");
                  }}
                >
                  <small>
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </small>
                  <strong>{day.getDate()}</strong>
                </button>
                {items.map((p) => (
                  <button
                    className="calendar-event"
                    key={p.id}
                    onClick={() => navigate(`post/${p.id}`)}
                  >
                    <small>{clock(p.eventAt)}</small>
                    {p.title}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <h2 className="section-heading">
        {mode === "day" ? "On this day" : "Coming together"}
      </h2>
      {!visible.length ? (
        <Empty title="A little room to breathe">
          No family events in this {mode}.
        </Empty>
      ) : (
        <div className="agenda">
          {visible.map((p) => (
            <button
              className="agenda-row surface"
              key={p.id}
              onClick={() => navigate(`post/${p.id}`)}
            >
              <div className="event-date">
                <strong>{new Date(p.eventAt).getDate()}</strong>
                <small>
                  {new Date(p.eventAt).toLocaleDateString(undefined, {
                    month: "short",
                  })}
                </small>
              </div>
              <div>
                <h3>{p.title}</h3>
                <p>
                  {clock(p.eventAt)}
                  {p.location ? ` · ${p.location}` : ""}
                </p>
              </div>
              <Icon name="right" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
