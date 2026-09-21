import type { Member, Post, ChatMessage } from "../../data";

/** Use the intersection of recipients' access, never the parent's wider view. */
export function familyAppContext(
  members: Member[],
  posts: Post[],
  chat: ChatMessage[],
  audience: string[],
) {
  const kids = members.filter(
    (m) => audience.includes(m.id) && m.role === "kid",
  );
  const visible = posts.filter(
    (p) =>
      p.status === "published" &&
      kids.every(
        (k) => p.audience.includes("family") || p.audience.includes(k.id),
      ),
  );
  const items = visible
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40)
    .map((p) => ({
      id: p.id,
      authorId: p.authorId,
      title: p.title,
      body: p.body.slice(0, 900),
      kind: p.kind,
      eventAt: p.eventAt,
      location: p.location,
    }));
  return {
    family: "The Parkers",
    members: members.map(({ id, name, role }) => ({ id, name, role })),
    posts: items,
    feed: items.map((p) => p.id),
    schedule: items.filter((p) => p.kind === "event"),
    chat: [...chat]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40)
      .reverse()
      .map(({ authorId, text, createdAt, mediaType }) => ({
        authorId,
        text: text.slice(0, 500),
        createdAt,
        mediaType,
      })),
    capturedAt: new Date().toISOString(),
  };
}
export function extractAppSource(text: string) {
  // Providers may return prose and multiple code fences. Prefer the actual module.
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const blocks = [...clean.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const source = (blocks.find(block => /export\s+default\b/.test(block)) ?? clean).trim();
  if (!/export\s+default\b/.test(source))
    throw new Error("The response did not include a default-exported React component.");
  if (source.length > 60000)
    throw new Error(
      "The generated app is too large. Try a more focused prompt.",
    );
  return source;
}
