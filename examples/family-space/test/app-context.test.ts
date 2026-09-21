import { test, expect } from "bun:test";
import { familyAppContext, extractAppSource } from "../app-context";
import type { Member, Post } from "../data";
test("shared app context excludes posts private to a different kid and unpublished posts", () => {
  const members: Member[] = [
    { id: "emma", name: "Emma", role: "parent", avatar: "" },
    { id: "sam", name: "Sam", role: "kid", avatar: "" },
    { id: "zoe", name: "Zoe", role: "kid", avatar: "" },
  ];
  const base: Post = {
    id: "family",
    authorId: "emma",
    title: "Picnic",
    body: "",
    kind: "event",
    status: "published",
    audience: ["family"],
    createdAt: 1,
    mediaPath: "",
    cover: "",
    url: "",
    eventAt: "2026-09-20",
    location: "Park",
  };
  const posts = [
    base,
    { ...base, id: "sam", audience: ["sam"] },
    { ...base, id: "zoe", audience: ["zoe"] },
    { ...base, id: "draft", status: "pending" as const },
  ];
  expect(
    familyAppContext(members, posts, [], ["emma", "sam"]).posts.map(
      (p) => p.id,
    ),
  ).toEqual(["family", "sam"]);
  expect(
    familyAppContext(members, posts, [], ["emma", "sam", "zoe"]).schedule.map(
      (p) => p.id,
    ),
  ).toEqual(["family"]);
  expect(
    extractAppSource(
      "Here is the app:\n```tsx\nexport default function App(){}\n```",
    ),
  ).toContain("export default");
});

test("source extraction finds React after prose, reasoning tags, and unrelated fences", () => {
  expect(extractAppSource('<think>planning</think>\n```json\n{}\n```\n```tsx\nexport default function App(){return <h1>Hello</h1>}\n```')).toStartWith('export default');
  expect(() => extractAppSource('I can help you build that.')).toThrow('default-exported React');
});
