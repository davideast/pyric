import { useEffect, useState } from "react";
import {
  subscribeAssuranceVisualizations,
  type AssuranceVisualizationSnapshot,
} from "pyric-tools/assurance/browser";
import { currentPath } from "../../shell/router.js";
import { ASSURANCE_DEMO_CAMPAIGN } from "./demo.js";

const SESSION_INDEX = "pyric:assurance:campaigns";
const SESSION_PREFIX = "pyric:assurance:campaign:";

function isSnapshot(value: unknown): value is AssuranceVisualizationSnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { schema?: unknown }).schema ===
      "pyric.assurance.visualization.v1" &&
    typeof (value as { campaignId?: unknown }).campaignId === "string"
  );
}

function readPersisted(): AssuranceVisualizationSnapshot[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const ids = JSON.parse(
      sessionStorage.getItem(SESSION_INDEX) ?? "[]",
    ) as unknown;
    if (!Array.isArray(ids)) return [];
    const persisted = ids
      .map((id) => sessionStorage.getItem(`${SESSION_PREFIX}${String(id)}`))
      .filter((raw): raw is string => !!raw)
      .map((raw) => JSON.parse(raw) as unknown)
      .filter(isSnapshot);
    if (
      persisted.length === 0 &&
      import.meta.env.DEV &&
      currentPath().query.demo === "assurance"
    ) {
      return [ASSURANCE_DEMO_CAMPAIGN];
    }
    return persisted;
  } catch {
    return import.meta.env.DEV && currentPath().query.demo === "assurance"
      ? [ASSURANCE_DEMO_CAMPAIGN]
      : [];
  }
}

function persist(snapshot: AssuranceVisualizationSnapshot): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const existing = JSON.parse(
      sessionStorage.getItem(SESSION_INDEX) ?? "[]",
    ) as unknown;
    const ids = Array.isArray(existing) ? existing.map(String) : [];
    if (!ids.includes(snapshot.campaignId)) ids.push(snapshot.campaignId);
    sessionStorage.setItem(SESSION_INDEX, JSON.stringify(ids));
    sessionStorage.setItem(
      `${SESSION_PREFIX}${snapshot.campaignId}`,
      JSON.stringify(snapshot),
    );
  } catch {
    // Session persistence is optional; the live visualization remains usable.
  }
}

function upsert(
  campaigns: AssuranceVisualizationSnapshot[],
  incoming: AssuranceVisualizationSnapshot,
): AssuranceVisualizationSnapshot[] {
  const index = campaigns.findIndex(
    (item) => item.campaignId === incoming.campaignId,
  );
  if (index === -1) return [...campaigns, incoming];
  const next = [...campaigns];
  next[index] = incoming;
  return next;
}

export function useAssuranceCampaigns(): AssuranceVisualizationSnapshot[] {
  const [campaigns, setCampaigns] =
    useState<AssuranceVisualizationSnapshot[]>(readPersisted);

  useEffect(() => {
    const receive = (snapshot: AssuranceVisualizationSnapshot) => {
      persist(snapshot);
      setCampaigns((current) => upsert(current, snapshot));
    };
    const unsubscribe = subscribeAssuranceVisualizations(receive);
    return () => {
      unsubscribe();
    };
  }, []);

  return campaigns;
}
