// Real worker/provider smoke with empty synthetic context; no family data reads.
import { chromium } from "playwright";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/");
  const result = await page.evaluate(async () => {
    const { generationClient, generationControl } = await import(
      "/durable-generation.ts"
    );
    const client = generationClient();
    await generationControl("active", "");
    const { jobId } = await client.start({
      id: crypto.randomUUID(),
      ownerId: "synthetic-test",
      title: "Synthetic counter",
      prompt:
        "Return a tiny React component with one heading Synthetic test and an in-memory counter button. No family data is supplied.",
      context: JSON.stringify({
        family: "Synthetic test",
        members: [],
        posts: [],
        feed: [],
        schedule: [],
        chat: [],
      }),
      audience: [],
      createdAt: Date.now(),
    });
    let last;
    for await (const event of client.subscribe(jobId)) {
      if (event.kind === "event") last = event.value;
    }
    if (!last?.job.draft)
      throw new Error(last?.job.error ?? "No completed draft");
    return { compiled: true, events: last.job.events.map((e) => e.title) };
  });
  console.log(result);
} finally {
  await browser.close();
}
