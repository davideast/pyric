import { describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import {
  createTreatmentController,
  FLOW_TREATMENT_KEY,
} from "../../../src/serve/runtime/flow-treatments/controller.js";
import { builtinLoaders } from "../../../src/serve/runtime/flow-treatments/builtins.js";
import type {
  FlowTreatment,
  FlowTreatmentManifest,
} from "../../../src/serve/runtime/flow-treatments/types.js";

const manifest: FlowTreatmentManifest = {
  treatment: "corners",
  treatments: [
    {
      id: "test:quiet",
      name: "Quiet",
      description: "Quiet outlines",
      group: "Custom",
      url: "/quiet.js",
    },
    {
      id: "test:slow",
      name: "Slow",
      description: "",
      group: "Custom",
      url: "/slow.js",
    },
  ],
};
function setup(
  options: {
    load?: (url: string) => Promise<{ default: FlowTreatment }>;
    stored?: string;
  } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="target" data-pyric-flow="0" data-pyric-flow-listener="one"></div><div id="overlay"></div></body>',
    { url: "http://localhost" },
  );
  if (options.stored)
    dom.window.localStorage.setItem(FLOW_TREATMENT_KEY, options.stored);
  const controller = createTreatmentController({
    document: dom.window.document,
    manifest,
    onChange() {},
    load: options.load,
  });
  return {
    dom,
    controller,
    target: dom.window.document.querySelector<HTMLElement>("#target")!,
    container: dom.window.document.querySelector<HTMLElement>("#overlay")!,
  };
}

describe("Flow treatment lifecycle", () => {
  it("honors a selection made while the overlay is discovering configuration", async () => {
    const dom = new JSDOM('<div id="overlay"></div>', {
      url: "http://localhost",
    });
    let finish!: (response: Response) => void;
    dom.window.fetch = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const controller = createTreatmentController({
      document: dom.window.document,
      onChange() {},
    });
    const attaching = controller.attach(
      dom.window.document.querySelector<HTMLElement>("#overlay")!,
    );
    const choosing = controller.select("corners");
    finish(Response.json({ treatment: "outline", treatments: [] }));
    await Promise.all([attaching, choosing]);
    expect(controller.state().selected).toBe("corners");
    expect(dom.window.document.documentElement.dataset.pyricTreatment).toBe(
      "corners",
    );
    expect(dom.window.localStorage.getItem(FLOW_TREATMENT_KEY)).toBe("corners");
    controller.dispose();
    dom.window.close();
  });
  it("uses the stored choice over the project default and ignores missing stored ids", async () => {
    for (const [stored, expected] of [
      ["rail", "rail"],
      ["removed:custom", "corners"],
    ]) {
      const { controller, container, dom } = setup({ stored });
      await controller.attach(container);
      expect(controller.state().selected).toBe(expected);
      expect(dom.window.document.documentElement.dataset.pyricTreatment).toBe(
        expected,
      );
      controller.dispose();
      dom.window.close();
    }
  });
  it("repaints existing marks without counting another delivery and clears annotations on dispose", async () => {
    const { controller, container, target, dom } = setup();
    await controller.attach(container);
    controller.record({
      listenerId: "one",
      label: "Chat",
      target: "messages",
      deliveryCount: 1,
      subtree: {
        root: null,
        leaves: [],
        components: [
          { element: target, name: "Message", kind: "component", depth: 0 },
        ],
      },
    });
    const sequence = target.dataset.pyricFlowSequence;
    for (const id of Object.keys(builtinLoaders)) {
      await controller.select(id);
      expect(controller.state().error).toBeNull();
      expect(target.dataset.pyricFlowSequence).toBe(sequence);
      expect(target.dataset.pyricFlowHits).toBe("1");
      expect(
        container.querySelectorAll("[data-pyric-treatment-style]"),
      ).toHaveLength(1);
    }
    controller.dispose();
    expect(target.hasAttribute("data-pyric-flow-hits")).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(
      dom.window.document.documentElement.hasAttribute("data-pyric-treatment"),
    ).toBe(false);
    dom.window.close();
  });
  it("keeps the working style on load failure and retries the failed module with a new URL", async () => {
    const urls: string[] = [];
    const { controller, container, dom } = setup({
      load: async (url) => {
        urls.push(url);
        if (urls.length === 1) throw new Error("offline");
        return { default: { css: "" } };
      },
    });
    await controller.attach(container);
    await controller.select("test:quiet");
    expect(controller.state().selected).toBe("corners");
    expect(controller.state().retry).toBe("test:quiet");
    expect(dom.window.document.documentElement.dataset.pyricTreatment).toBe(
      "corners",
    );
    await controller.select("test:quiet");
    expect(controller.state().error).toBeNull();
    expect(urls[0]).not.toBe(urls[1]);
    expect(dom.window.localStorage.getItem(FLOW_TREATMENT_KEY)).toBe(
      "test:quiet",
    );
    controller.dispose();
    dom.window.close();
  });
  it("ignores a late import after selection changes or the overlay is disposed", async () => {
    let finish: (module: { default: FlowTreatment }) => void = () => {};
    const { controller, container, dom } = setup({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await controller.attach(container);
    const slow = controller.select("test:slow");
    await controller.select("rail");
    finish({ default: { css: "body { color: red; }" } });
    await slow;
    expect(controller.state().selected).toBe("rail");
    const pending = controller.select("test:quiet");
    controller.dispose();
    finish({ default: { css: "" } });
    await pending;
    expect(container.children).toHaveLength(0);
    dom.window.close();
  });
});
