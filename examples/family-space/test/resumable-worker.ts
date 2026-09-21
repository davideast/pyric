import { noteSource, noteCases } from "./authored-policy-fixture";
import { chorePolicy } from "../app-policy";
import choreSource from "../templates/generated/chore-quest.tsx?raw";
// Test-only SharedWorker: real host, IDB, compilation and recovery; no AI network.
import { createGenerationHost } from "../generation-host";
import { compileFamilyApp } from "../app-compiler";
const source =
  "import {useAppData} from '@kin/app'; export default function App(){const {records,setRecord,loading}=useAppData();const count=records.find(r=>r.id==='counter')?.count||0;return <main><h1>Family kindness</h1><p>Count: {count}</p><button disabled={loading} onClick={()=>setRecord('counter',{count:count+1})}>Add kindness</button></main>}";
let stalledOnce = false;
const model = {
  async generateContentStream(prompt: string) {
    const stage = prompt.match(/WORKFLOW_STAGE: ([\w-]+)/)?.[1];
    if (stage === "plan" && prompt.includes("[stall-once]") && !stalledOnce) {
      stalledOnce = true;
      return {
        response: new Promise<never>(() => {}),
        stream: (async function* () {
          yield { text: () => "Waiting for the test provider" };
          await new Promise<never>(() => {});
        })(),
      };
    }
    if (stage && stage !== "code") {
      let value: unknown;
      if (stage === "plan")
        value = {
          mode: prompt.includes("[policy-notes]")
            ? "authored"
            : prompt.includes("[policy-chore]")
              ? "chore-quest-v1"
              : "family-trust",
          summary: "Fixture permissions",
          requirements: ["Enforce ownership"],
          recordSchema: {
            owner: "uid",
            text: "string",
            recipient: "member uid",
          },
          modules: ["auth"],
          capabilities: [],
        };
      if (stage === "policy-source") value = noteSource;
      if (stage === "policy-cases") value = noteCases;
      if (stage === "ui")
        value = {
          needs: ["persistent records", "layout", "feedback"],
          ids: ["persistent-records"],
        };
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const chunk = { text: () => text };
      return {
        response: Promise.resolve(chunk),
        stream: (async function* () {
          yield chunk;
        })(),
      };
    }

    if (!stage && prompt.includes("Host phase: POLICY_SELECTION")) {
      const result = prompt.includes("[policy-notes]")
        ? prompt.includes("Policy checks passed")
          ? {
              done: {
                mode: "authored",
                summary: "Members manage their own notes.",
              },
            }
          : {
              calls: [
                {
                  name: "pyric_can_i_use",
                  args: { feature: "firestore-rules/get" },
                },
                { name: "rules_stdlib_get", args: { key: "auth" } },
                {
                  name: "app_policy_prepare",
                  args: {
                    source: noteSource,
                    summary: "Members manage their own notes.",
                    cases: noteCases,
                  },
                },
                { name: "app_policy_test", args: {} },
              ],
            }
        : prompt.includes("[policy-chore]")
          ? prompt.includes("Policy checks passed")
            ? {
                done: {
                  mode: "chore-quest-v1",
                  summary:
                    "Parents manage chores; kids complete their assigned chores.",
                },
              }
            : {
                calls: [
                  {
                    name: "pyric_can_i_use",
                    args: { feature: "firestore-rules/get" },
                  },
                  { name: "rules_stdlib_get", args: { key: "auth" } },
                  {
                    name: "app_policy_prepare",
                    args: { source: chorePolicy.source },
                  },
                  { name: "app_policy_test", args: {} },
                ],
              }
          : prompt.includes("Previous tool results: []")
            ? {
                calls: [
                  {
                    name: "pyric_can_i_use",
                    args: { feature: "firestore-rules/get" },
                  },
                  { name: "rules_stdlib_get", args: { key: "auth" } },
                ],
              }
            : {
                done: {
                  mode: "family-trust",
                  summary:
                    "A shared family counter with no additional role restrictions.",
                },
              };
      const chunk = { text: () => JSON.stringify(result) };
      return {
        response: Promise.resolve(chunk),
        stream: (async function* () {
          yield chunk;
        })(),
      };
    }
    if (prompt.includes("Host phase: UI_SELECTION")) {
      const chunk = {
        text: () =>
          JSON.stringify({
            needs: ["persistent records", "layout", "feedback"],
            ids: ["persistent-records"],
          }),
      };
      return {
        response: Promise.resolve(chunk),
        stream: (async function* () {
          yield chunk;
        })(),
      };
    }
    if (prompt.includes("[fail-build]"))
      throw new Error("Deliberate test model failure");
    const output = prompt.includes("[startup-failure]")
      ? "export default function App(){return <p>{missingBinding}</p>}"
      : prompt.includes("[policy-notes]")
        ? "import {useAppData,useAppIdentity} from '@kin/app'; export default function App(){ const {records,setRecord,loading}=useAppData(); const identity=useAppIdentity(); return <main><h1>Family notes</h1><button disabled={loading || !identity.user?.uid} onClick={()=>setRecord('note',{owner:identity.user.uid,text:'Saved note',recipient:'sam'})}>Save my note</button>{records.map(r=><p key={r.id}>{r.text}</p>)}</main>}"
        : prompt.includes("[policy-chore]")
          ? choreSource
          : source;
    const chunk = { text: () => output };
    return {
      response: Promise.resolve(chunk),
      stream: (async function* () {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 600));
          yield {
            text: () =>
              output.slice(
                i * Math.ceil(output.length / 4),
                (i + 1) * Math.ceil(output.length / 4),
              ),
          };
        }
      })(),
    };
  },
};
const host = createGenerationHost(
  async () => model,
  async (source) => {
    await new Promise((r) => setTimeout(r, 4000));
    return compileFamilyApp(source);
  },
);
self.addEventListener("connect", ((event: MessageEvent) => {
  const port = event.ports[0];
  host.connect(port);
  port.start();
  port.addEventListener("message", (event) => {
    if (event.data?.kinControl === "attach-ai") event.ports[0]?.close();
    if (event.data?.kinTestKill) (self as unknown as { close(): void }).close();
  });
}) as EventListener);
