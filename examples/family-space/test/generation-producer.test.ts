import { test, expect } from "bun:test";
import { generationProducer } from "../generation-producer";
import type { DurableGeneration, GenerationSpec } from "../generation-types";
const source = "export default function App(){return null}";
const spec: GenerationSpec = {
  id: "app-1",
  ownerId: "emma",
  title: "Test",
  prompt: "Test",
  context: "{}",
  audience: ["emma"],
  createdAt: 1,
};
test("completed source checkpoint resumes validation without a second model request", async () => {
  let calls = 0;
  const producer = generationProducer(
    {
      ...spec,
      checkpoint: source,
      previous: {
        id: "app-1",
        ownerId: "emma",
        title: "Test",
        state: "running",
        events: [],
      },
    },
    async () => {
      calls++;
      throw new Error("must not request");
    },
    async () => {},
  );
  const events: DurableGeneration[] = [];
  for await (const event of producer({
    jobId: "job",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(calls).toBe(0);
  expect(events.at(-1)?.job.draft?.id).toBe("app-1");
  expect(events.at(-1)?.job.draft?.source).toBe(source);
  expect(events.at(-1)?.job.events[0].title).toBe("Resuming your build");
});
test("malformed response is retained and repaired before producing a saveable draft", async () => {
  let calls = 0;
  const producer = generationProducer(
    spec,
    async () => ({
      async generateContentStream() {
        const text = ++calls === 1 ? "An idea" : source;
        const chunk = { text: () => text };
        return {
          response: Promise.resolve(chunk),
          stream: (async function* () {
            yield chunk;
          })(),
        };
      },
    }),
    async () => {},
  );
  let last: DurableGeneration | undefined;
  for await (const event of producer({
    jobId: "job",
    signal: new AbortController().signal,
  }))
    last = event;
  expect(calls).toBe(2);
  expect(last?.job.events.some((e) => e.detail === "An idea")).toBe(true);
  expect(last?.job.draft?.source).toBe(source);
});
import "fake-indexeddb/auto";
import { chorePolicy } from "../app-policy";
test("generated chore apps carry a tested policy and identity contract into React generation", async () => {
  const replies = [
    JSON.stringify({
      calls: [
        { name: "pyric_can_i_use", args: { feature: "firestore-rules/get" } },
        { name: "rules_stdlib_get", args: { key: "auth" } },
        { name: "app_policy_prepare", args: { source: chorePolicy.source } },
        { name: "app_policy_test", args: {} },
      ],
    }),
    JSON.stringify({
      done: {
        mode: "chore-quest-v1",
        summary: "Parents manage chores; kids complete their assigned chores.",
      },
    }),
    source,
  ];
  const producer = generationProducer(
    { ...spec, policyWorkflow: 1 },
    async () => ({
      async generateContentStream(prompt: string) {
        const text = replies.shift()!;
        if (!text) throw Error("Unexpected model request");
        if (text === source) expect(prompt).toContain("assigneeId");
        const chunk = {
          text: () =>
            text.startsWith("{") ? "```json\n" + text + "\n```" : text,
        };
        return {
          response: Promise.resolve(chunk),
          stream: (async function* () {
            yield chunk;
          })(),
        };
      },
    }),
    async () => {},
  );
  let last: DurableGeneration | undefined;
  for await (const event of producer({
    jobId: "policy",
    signal: new AbortController().signal,
  }))
    last = event;
  expect(last?.job.state).not.toBe("failed");
  expect(last?.job.draft?.policy?.id).toBe("chore-quest-v1");
  expect(last?.spec.policySelection?.validation?.sandboxPassed).toBe(28);
  expect(last?.job.events.some((e) => e.title === "Policy checks passed")).toBe(
    true,
  );
});
test("a required policy cannot be downgraded to family trust by a model response", async () => {
  const producer = generationProducer(
    { ...spec, policyWorkflow: 1, requiredPolicy: chorePolicy },
    async () => ({
      async generateContentStream() {
        const chunk = {
          text: () =>
            JSON.stringify({
              done: {
                mode: "family-trust",
                summary: "Everyone can do anything",
              },
            }),
        };
        return {
          response: Promise.resolve(chunk),
          stream: (async function* () {
            yield chunk;
          })(),
        };
      },
    }),
    async () => {
      throw Error("Must not compile");
    },
  );
  let last: DurableGeneration | undefined;
  for await (const event of producer({
    jobId: "deny",
    signal: new AbortController().signal,
  }))
    last = event;
  expect(last?.job.state).toBe("failed");
  expect(last?.job.draft).toBeUndefined();
  expect(last?.job.error).toContain("required policy");
});
test("policy checkpoints are revalidated rather than trusting saved evidence", async () => {
  const producer = generationProducer(
    {
      ...spec,
      policyWorkflow: 1,
      checkpoint: source,
      policySelection: {
        policy: { ...chorePolicy, resolved: "invalid" },
        summary: "forged",
      },
    },
    async () => {
      throw Error("Must not request");
    },
    async () => {},
  );
  let last: DurableGeneration | undefined;
  for await (const event of producer({
    jobId: "resume",
    signal: new AbortController().signal,
  }))
    last = event;
  expect(last?.job.state).toBe("failed");
  expect(last?.job.draft).toBeUndefined();
});
test("failed resumed policy validation never republishes a previous draft", async () => {
  const producer = generationProducer(
    {
      ...spec,
      policyWorkflow: 1,
      checkpoint: source,
      policySelection: {
        policy: { ...chorePolicy, resolved: "invalid" },
        summary: "bad",
      },
      previous: {
        id: spec.id,
        ownerId: spec.ownerId,
        title: spec.title,
        state: "running",
        events: [],
        draft: { ...spec, source, published: false },
      },
    },
    async () => {
      throw Error("Must not request");
    },
    async () => {},
  );
  for await (const event of producer({
    jobId: "resume-draft",
    signal: new AbortController().signal,
  }))
    expect(event.job.draft).toBeUndefined();
});
test("planning repairs malformed envelopes and requires discovery even for family-trust apps", async () => {
  const replies = [
    "null",
    "```json\nnull\n```",
    JSON.stringify({
      done: { mode: "family-trust", summary: "Shared counter" },
    }),
    JSON.stringify({
      calls: [
        { name: "pyric_can_i_use", args: { feature: "firestore-rules/get" } },
        { name: "rules_stdlib_get", args: { key: "auth" } },
      ],
    }),
    JSON.stringify({
      done: { mode: "family-trust", summary: "Shared counter" },
    }),
    source,
  ];
  const producer = generationProducer(
    { ...spec, policyWorkflow: 1 },
    async () => ({
      async generateContentStream() {
        const text = replies.shift();
        if (text === undefined) throw Error("Unexpected model request");
        const chunk = { text: () => text };
        return {
          response: Promise.resolve(chunk),
          stream: (async function* () {
            yield chunk;
          })(),
        };
      },
    }),
    async () => {},
  );
  let last: DurableGeneration | undefined;
  for await (const event of producer({
    jobId: "repair-envelope",
    signal: new AbortController().signal,
  }))
    last = event;
  expect(last?.job.draft?.source).toBe(source);
  expect(last?.job.draft?.policy).toBeUndefined();
  expect(
    last?.job.events.some((e) => e.title === "rules_stdlib_get result"),
  ).toBe(true);
});
test("policy planning retries a malformed model tool envelope within its bounded budget", async () => {
  const {selectPolicy} = await import("../generation-policy");
  let calls = 0;
  const selected = await selectPolicy("Shared counter",{
    async generateContentStream() {
      calls++;
      if (calls === 1) throw Error("Candidate was blocked due to MALFORMED_FUNCTION_CALL");
      const text = JSON.stringify(calls === 2 ? {calls:[
        {name:"pyric_can_i_use",args:{feature:"firestore-rules/get"}},
        {name:"rules_stdlib_get",args:{key:"auth"}}
      ]} : {done:{mode:"family-trust",summary:"Shared counter"}});
      const chunk = {text:()=>text};
      return {response:Promise.resolve(chunk),stream:(async function*(){yield chunk;})()};
    }
  },new AbortController().signal,()=>{});
  expect(selected.policy).toBe(null);
});
test("policy planning accepts unambiguous JSON tool envelopes without wasting repair attempts", async () => {
 const {selectPolicy} = await import("../generation-policy");
 const {noteSource,noteCases} = await import("./authored-policy-fixture");
 const replies = [
  {calls:[{name:"rules_stdlib_get",key:"auth"},{name:"pyric_can_i_use",feature:"firestore-rules/get"}]},
  {call:{name:"app_policy_prepare",source:noteSource,summary:"Own notes"}},
  {calls:[{name:"app_policy_cases",args:{cases:noteCases}},{name:"app_policy_test",args:{}}]},
 ];
 const selected = await selectPolicy("Own notes",{
  async generateContentStream() {
   const text=JSON.stringify(replies.shift() ?? {done:{mode:"authored",summary:"Own notes"}});
   const chunk={text:()=>text};
   return {response:Promise.resolve(chunk),stream:(async function*(){yield chunk;})()};
  }
 },new AbortController().signal,()=>{});
 expect(selected.policy?.format).toBe(2);
 expect(selected.validation?.failed).toBe(0);
});
test("exhausted policy repairs retain the actionable tool failure", async () => {
 const {selectPolicy} = await import("../generation-policy");
 await expect(selectPolicy("Own notes",{
  async generateContentStream() {
   const chunk={text:()=>JSON.stringify({calls:[{name:"app_policy_cases",args:{cases:[]}}]})};
   return {response:Promise.resolve(chunk),stream:(async function*(){yield chunk;})()};
  }
 },new AbortController().signal,()=>{})).rejects.toThrow("Last issue: app_policy_cases: Prepare authored policy source first");
});
