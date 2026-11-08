import { describe, expect, test } from "bun:test";
import type { ToolContext } from "pyric/sandbox/internal";
import { createDeriveAssuranceTool } from "../../src/assurance/derive-tool.js";
import { AssuranceCampaignStore } from "../../src/assurance/tools.js";

const toolContext: ToolContext = { signal: new AbortController().signal };

describe("derive-tool", () => {
  test("returns structured AssuranceInputError failure when root does not exist", async () => {
    const store = new AssuranceCampaignStore();
    const tool = createDeriveAssuranceTool(store);
    const res = await tool.execute(
      { root: "/nonexistent/pyric-derive-missing-dir" },
      toolContext,
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("does not exist");
  });
});
