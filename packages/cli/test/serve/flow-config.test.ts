import { expect, it } from "bun:test";
import {
  resolveFlowConfig,
  flowManifest,
} from "../../src/serve/flow-config.js";
it("resolves project defaults and explicit overrides without duplicating built-ins", () => {
  const config = resolveFlowConfig(
    {
      treatment: "corners",
      treatments: [{ id: "team:quiet", label: "Quiet", module: "./quiet.ts" }],
    },
    { treatment: "team:quiet" },
  );
  expect(flowManifest(config)).toEqual({
    treatment: "team:quiet",
    treatments: [
      {
        id: "team:quiet",
        name: "Quiet",
        description: "",
        group: "Custom",
        url: "/__pyric/flow/custom/team%3Aquiet.js",
      },
    ],
  });
  expect(flowManifest(resolveFlowConfig(undefined))).toEqual({
    treatment: "outline",
    treatments: [],
  });
});
it("rejects malformed, duplicate, and unavailable treatment registrations", () => {
  for (const value of [
    null,
    [],
    { treatment: 1 },
    { treatment: "missing" },
    { treatments: {} },
    { treatments: [{ id: "outline", label: "Outline", module: "./x.ts" }] },
    {
      treatments: [
        { id: "a:b", label: "One", module: "./x.ts" },
        { id: "a:b", label: "Two", module: "./y.ts" },
      ],
    },
  ])
    expect(() => resolveFlowConfig(value)).toThrow();
});
