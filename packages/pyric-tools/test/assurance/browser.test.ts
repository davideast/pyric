import { describe, expect, it } from "bun:test";
import {
  publishAssuranceVisualization,
  subscribeAssuranceVisualizations,
  type AssuranceVisualizationSnapshot,
} from "../../src/assurance/browser.js";

describe("assurance browser transport", () => {
  it("delivers credential-free campaign snapshots without requiring a browser runtime", () => {
    const received: AssuranceVisualizationSnapshot[] = [];
    const unsubscribe = subscribeAssuranceVisualizations((snapshot) =>
      received.push(snapshot),
    );
    const snapshot: AssuranceVisualizationSnapshot = {
      schema: "pyric.assurance.visualization.v1",
      campaignId: "browser-transport",
      observations: [],
      probes: [],
    };

    publishAssuranceVisualization(snapshot);
    unsubscribe();
    publishAssuranceVisualization({
      ...snapshot,
      campaignId: "after-unsubscribe",
    });

    expect(received).toEqual([snapshot]);
  });
});
