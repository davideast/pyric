import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import { runBuildWorkflow } from "../build-workflow";
import { initialWorkflow } from "../build-workflow-types";
import type { WorkflowState } from "../build-workflow-types";
import { noteSource, noteCases } from "./authored-policy-fixture";
const input = {
  id: "a",
  buildId: "b",
  ownerId: "daniel",
  title: "Notes",
  prompt: "Own notes",
  context: "{}",
  audience: ["daniel"],
  createdAt: 1,
};
test("authored policy is tested by the host before code and survives interruption", async () => {
  let durable = initialWorkflow(input);
  const replies = [
    JSON.stringify({
      mode: "authored",
      summary: "Own notes",
      requirements: ["Only owners may write"],
      recordSchema: { owner: "uid", text: "string", recipient: "member uid" },
      modules: ["auth"],
      capabilities: ["firestore-rules/get"],
    }),
    noteSource,
    JSON.stringify(noteCases),
  ];
  const model = {
    async generateContentStream() {
      const text = replies.shift();
      if (!text) throw Error("interrupted model");
      const chunk = { text: () => text };
      return {
        response: Promise.resolve(chunk),
        stream: (async function* () {
          yield chunk;
        })(),
      };
    },
  };
  await runBuildWorkflow(
    durable,
    {
      model: async () => model,
      compile: async () => {},
      startup: async () => {},
      save: async () => {},
      checkpoint: async (state: WorkflowState) => {
        durable = structuredClone(state);
      },
      event: () => {},
    },
    new AbortController().signal,
  );
  expect(durable.policy?.validation?.failed).toBe(0);
  expect(durable.policy?.validation?.sandboxPassed).toBeGreaterThan(0);
  expect(durable.stage).toBe("code");
  expect(durable.status).toBe("needs-attention");
  expect(durable.files["/work/policy.rules"]).toBe(noteSource);
});
test("a failed checkpoint acknowledgement never advances generation", async () => {
  let called = false;
  await expect(
    runBuildWorkflow(
      initialWorkflow(input),
      {
        model: async () => {
          called = true;
          throw Error("must not generate");
        },
        compile: async () => {},
        startup: async () => {},
        save: async () => {},
        checkpoint: async () => {
          throw Error("offline");
        },
        event: () => {},
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("offline");
  expect(called).toBe(false);
});
test("a restored compiling workspace reaches ready without another model request", async () => {
  const state = initialWorkflow(input);
  state.stage = "compile";
  state.files["/work/App.tsx"] = "export default function App(){return null}";
  state.policy = { policy: null, summary: "family" };
  let saved: WorkflowState | undefined;
  const result = await runBuildWorkflow(
    state,
    {
      model: async () => {
        throw Error("must not generate");
      },
      compile: async () => {},
      startup: async () => {},
      save: async (next) => {
        saved = next;
      },
      checkpoint: async () => {},
      event: () => {},
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("ready");
  expect(saved?.startupPassed).toBe(true);
});
test("startup failures exhaust two repairs and never save a ready candidate", async () => {
  const state = initialWorkflow(input);
  state.stage = "startup";
  state.files["/work/App.tsx"] = "export default function App(){return null}";
  state.policy = { policy: null, summary: "family" };
  const source = "export default function App(){return null}";
  let saved = false;
  const model = {
    async generateContentStream() {
      const chunk = { text: () => source };
      return {
        response: Promise.resolve(chunk),
        stream: (async function* () {
          yield chunk;
        })(),
      };
    },
  };
  const result = await runBuildWorkflow(
    state,
    {
      model: async () => model,
      compile: async () => {},
      startup: async () => {
        throw Error("useAppData is not defined");
      },
      save: async () => {
        saved = true;
      },
      checkpoint: async () => {},
      event: () => {},
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("needs-attention");
  expect(result.attempts.startup).toBe(2);
  expect(result.diagnostic).toContain("useAppData");
  expect(saved).toBe(false);
});
test("a terminal checkpoint replay stays ready without repeating validation or saving", async () => {
  const state = initialWorkflow(input);
  state.stage = "done";
  state.status = "ready";
  const unexpected = async () => {
    throw Error("terminal replay performed work");
  };
  const result = await runBuildWorkflow(
    state,
    {
      model: unexpected,
      compile: unexpected,
      startup: unexpected,
      save: unexpected,
      checkpoint: unexpected,
      event: () => {},
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("ready");
});

test("stopping a build interrupts an unresponsive model instead of retaining its executor", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = runBuildWorkflow(
    initialWorkflow(input),
    {
      model: async () => ({
        generateContentStream: async () => {
          entered();
          return new Promise<never>(() => {});
        },
      }),
      compile: async () => {},
      startup: async () => {},
      save: async () => {},
      checkpoint: async () => {},
      event: () => {},
    },
    abort.signal,
  );
  await requested;
  abort.abort(new Error("Parent stopped build"));
  const result = await Promise.race([
    work.then(
      () => "completed",
      (e) => e.message,
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still waiting for model"), 150),
    ),
  ]);
  expect(result).toBe("Parent stopped build");
});

test("a silent model pauses with a retained diagnostic instead of spending repair attempts", async () => {
  const original = globalThis.setTimeout;
  // Time is the external boundary: exercise the actual workflow deadline without a 90s test.
  const { spyOn } = await import("bun:test");
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    (callback, ms, ...args) =>
      original(callback, ms === 90000 ? 10 : ms, ...args),
  );
  let durable = initialWorkflow(input);
  try {
    await expect(
      runBuildWorkflow(
        durable,
        {
          model: async () => ({
            generateContentStream: async () => new Promise<never>(() => {}),
          }),
          compile: async () => {},
          startup: async () => {},
          save: async () => {},
          checkpoint: async (state) => {
            durable = structuredClone(state);
          },
          event: () => {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("no progress for 90 seconds");
    expect(durable.stage).toBe("plan");
    expect(durable.status).toBe("interrupted");
    expect(durable.attempts.plan).toBe(1);
    expect(durable.diagnostic).toContain("Resume");
  } finally {
    timer.mockRestore();
  }
});

test("stop also interrupts waiting for the AI worker connection", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = runBuildWorkflow(
    initialWorkflow(input),
    {
      model: async () => {
        entered();
        return new Promise<never>(() => {});
      },
      compile: async () => {},
      startup: async () => {},
      save: async () => {},
      checkpoint: async () => {},
      event: () => {},
    },
    abort.signal,
  );
  await requested;
  abort.abort(new Error("Stop connection wait"));
  const result = await Promise.race([
    work.then(
      () => "completed",
      (e) => e.message,
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("connection is still waiting"), 150),
    ),
  ]);
  expect(result).toBe("Stop connection wait");
});
