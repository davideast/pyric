import "fake-indexeddb/auto";
import { test, expect } from "bun:test";
import { createGenerationPolicyTools } from "../generation-policy-tools";
import { chorePolicy } from "../app-policy";
test("prepared modular policy must pass evaluator and sandbox checks before it can be selected", async () => {
  const tools = createGenerationPolicyTools();
  const prepared = await tools.call("app_policy_prepare", {
    source: chorePolicy.source,
  });
  expect(prepared.ok).toBe(true);
  expect(() => tools.selection()).toThrow();
  const tested = await tools.call("app_policy_test", {});
  expect(tested.ok).toBe(true);
  const selected = tools.selection();
  expect(selected.policy?.id).toBe("chore-quest-v1");
  expect(selected.validation?.passed).toBe(28);
  expect(selected.validation?.sandboxPassed).toBe(28);
  const altered = await tools.call("app_policy_prepare", {
    source: chorePolicy.source.replace(
      "['completed']",
      "['completed', 'title']",
    ),
  });
  expect(altered.ok).toBe(false);
  expect(() => tools.selection()).toThrow();
});
