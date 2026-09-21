import { readFile } from "node:fs/promises";
// Optional live-provider smoke: synthetic context, no production writes or family reads.
import { chromium } from "playwright";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/");
  const result = await page.evaluate(async ({authored, prompt}) => {
    const { generationClient, generationControl } =
      await import("/durable-generation.ts");
    const client = generationClient();
    await generationControl("active", "");
    const { jobId } = await client.start({
      policyWorkflow: 1,
      id: crypto.randomUUID(),
      ownerId: "parent",
      title: authored ? "Synthetic note policy" : "Synthetic chore policy",
      prompt: prompt || (authored
        ? "Build a family notes app with an authored policy. A member can create a note with owner equal to their current UID and text a string. Only the owner may update text, without changing owner, or delete the note. Parents have the same ownership restrictions. Nonmembers and signed-out users cannot write. Everyone in the family can read. Use top-level owner and text fields, useAppIdentity and useAppData. Do not create default records automatically. Prepare and validate modular rules and permission cases through tools."
        : "Build a tiny chore board using exactly the chore-quest-v1 contract. Parents create, rename, assign, complete, undo, and delete chores. Kids only toggle completed on chores assigned to their UID. Use title (nonblank up to 160 chars), assigneeId (current member), completed (boolean); preserve other fields. No other policy requirements. Use live identity. Do not create default records automatically."),
      context: JSON.stringify({
        members: [
          { id: "parent", name: "Test parent", role: "parent" },
          { id: "kid", name: "Test kid", role: "kid" },
        ],
        posts: [],
        chat: [],
        schedule: [],
      }),
      audience: ["parent"],
      createdAt: Date.now(),
    });
    let last;
    for await (const event of client.subscribe(jobId))
      if (event.kind === "event") last = event.value;
    if (!last?.job.draft?.policy)
      throw Error((last?.job.error ?? "No policy-bearing draft") + "\n" + JSON.stringify(last?.job.events.map(e=>({title:e.title,detail:e.detail.slice(0,2000)}))));
    return {
      policy: last.job.draft.policy.id,
      passed: last.spec.policySelection.validation.passed,
      events: last.job.events.map((e) => e.title),
    };
  }, {authored:process.env.KIN_AUTHORED_POLICY === "1",prompt:process.env.KIN_POLICY_PROMPT_FILE ? await readFile(process.env.KIN_POLICY_PROMPT_FILE,"utf8") : ""});
  if (process.env.KIN_AUTHORED_POLICY === "1" && result.policy !== "authored-v1") throw Error("Expected authored policy");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
