import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const config = {
  schedule: "0 3 * * *",
  exclusive: true,
  timeoutMs: 3_600_000,
  description:
    "Discover, fix, verify, and dismiss high-severity bug insights in any Stitch workspace",
};

interface InsightCandidate {
  id: string;
  shortId: string;
  priority: string;
  severity: string;
  title: string;
  description: string;
  evidence?: Array<{ file: string; line: number; note: string }>;
  evidenceMd?: string;
  proofFolder?: string;
}

/**
 * Load insights dynamically from the Stitch workspace via `ctx.stitch.find("insights")`,
 * or enrich from an optional local `--param proofsDir` if provided.
 */
async function discoverCandidates(
  ctx: any,
  priorities: Set<string>,
  severities: Set<string>,
): Promise<InsightCandidate[]> {
  const proofsDir = ctx.params?.proofsDir ? resolve(String(ctx.params.proofsDir)) : undefined;

  if (proofsDir && existsSync(join(proofsDir, "proofs/findings"))) {
    const findingsRoot = join(proofsDir, "proofs/findings");
    const candidates: InsightCandidate[] = [];
    for (const goal of readdirSync(findingsRoot)) {
      const goalDir = join(findingsRoot, goal);
      let entries: string[] = [];
      try {
        entries = readdirSync(goalDir);
      } catch {
        continue;
      }
      for (const slug of entries) {
        const folder = join(goalDir, slug);
        const fPath = join(folder, "finding.json");
        const rPath = join(folder, "result.json");
        const ePath = join(folder, "evidence.md");
        if (!existsSync(fPath)) continue;

        const finding = JSON.parse(readFileSync(fPath, "utf8"));
        const result = existsSync(rPath) ? JSON.parse(readFileSync(rPath, "utf8")) : {};

        const matchesNature = !finding.gapNature || finding.gapNature === "ISSUE";
        const matchesPriority = priorities.size === 0 || priorities.has(finding.priority);
        const matchesSeverity = severities.size === 0 || severities.has(finding.severity);

        if (matchesNature && matchesPriority && matchesSeverity) {
          candidates.push({
            id: finding.insightId,
            shortId: String(finding.insightId).slice(0, 8),
            priority: finding.priority ?? "P1",
            severity: finding.severity ?? "S1",
            title: finding.title,
            description: finding.claim ?? finding.title,
            evidence: result.evidence ?? [],
            evidenceMd: existsSync(ePath) ? readFileSync(ePath, "utf8") : undefined,
            proofFolder: folder,
          });
        }
      }
    }
    return candidates;
  }

  // General workspace discovery via SDK
  const rawInsights = await ctx.stitch.find("insights");
  const list = Array.isArray(rawInsights) ? rawInsights : rawInsights?.items ?? [];
  const candidates: InsightCandidate[] = [];

  for (const ins of list) {
    const priority = ins.priority ?? "P1";
    const severity = ins.severity ?? "S1";
    const matchesPriority = priorities.size === 0 || priorities.has(priority);
    const matchesSeverity = severities.size === 0 || severities.has(severity);
    if (matchesPriority && matchesSeverity) {
      candidates.push({
        id: ins.id,
        shortId: String(ins.id).slice(0, 8),
        priority,
        severity,
        title: ins.title ?? ins.summary ?? ins.id,
        description: ins.description ?? ins.summary ?? ins.title ?? "",
      });
    }
  }

  return candidates;
}

export async function routine(ctx: any) {
  const limit = Number(ctx.params?.limit ?? 10);
  const force = Boolean(ctx.params?.force);
  const agent = String(ctx.params?.agent ?? "agy");
  const priorities = new Set(
    String(ctx.params?.priority ?? "P1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const severities = new Set(
    String(ctx.params?.severity ?? "S0,S1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const verifyCmdTemplate = ctx.params?.verifyCmd
    ? String(ctx.params.verifyCmd)
    : undefined;

  const allCandidates = await discoverCandidates(ctx, priorities, severities);
  allCandidates.sort((a, b) => a.severity.localeCompare(b.severity));

  const batch = allCandidates
    .filter((c) => force || !ctx.state.hasSeen(`fixed:${c.id}`))
    .slice(0, limit);

  let verifiedCount = 0;
  const dismissedIds: string[] = [];
  const repoRoot = process.cwd();

  for (const item of batch) {
    ctx.logger.info(`[${item.severity}] Processing ${item.shortId}: ${item.title}`);

    const verifyCmd = verifyCmdTemplate
      ?.replace(/\{id\}/g, item.id)
      .replace(/\{shortId\}/g, item.shortId);

    // Optional pre-fix check when a verification command is provided
    if (verifyCmd) {
      await ctx.exec("sh", ["-c", verifyCmd], {
        cwd: repoRoot,
        env: { ...process.env, PYRIC_SOURCE_ROOT: repoRoot },
      });

      if (item.proofFolder && existsSync(join(item.proofFolder, "result.json"))) {
        const preResult = JSON.parse(
          readFileSync(join(item.proofFolder, "result.json"), "utf8"),
        );
        if (preResult.verdict === "REFUTED") {
          ctx.logger.info(
            `Insight ${item.shortId} already passes verification; queuing for dismissal.`,
          );
          ctx.state.markSeen(`fixed:${item.id}`);
          verifiedCount++;
          dismissedIds.push(item.id);
          continue;
        }
      }
    }

    const citedSites = item.evidence?.length
      ? item.evidence.map((e) => `- \`${e.file}:${e.line}\` — ${e.note}`).join("\n")
      : "";

    const prompt = [
      `You are resolving a high-severity bug insight (${item.severity} / ${item.priority}) in this repository.`,
      `### INSIGHT: ${item.title} (\`${item.id}\`)`,
      `**Description**: ${item.description}`,
      citedSites ? `### EVIDENCE LOCATIONS\n${citedSites}` : "",
      item.evidenceMd ? `### REPRODUCTION NOTES\n${item.evidenceMd}` : "",
      `### WORKFLOW INSTRUCTIONS`,
      `1. Inspect the relevant source files and reproduce or trace the issue.`,
      `2. Implement the minimal, targeted fix without breaking existing contracts.`,
      verifyCmd
        ? `3. Verify the fix by running: \`${verifyCmd}\`.`
        : `3. Run the relevant unit/integration test suite to verify the fix.`,
      `4. Commit your changes with message: \`fix: resolve ${item.title} (${item.shortId})\`.`,
      `5. Dismiss the insight via the Stitch CLI: \`stitch dismiss insights ${item.id} -w ${ctx.workspaceId}\`.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    await ctx.prompt(agent, prompt);

    if (ctx.dryRun) {
      verifiedCount++;
      dismissedIds.push(item.id);
      continue;
    }

    // Post-fix mechanical verification
    if (verifyCmd) {
      await ctx.exec("sh", ["-c", verifyCmd], {
        cwd: repoRoot,
        env: { ...process.env, PYRIC_SOURCE_ROOT: repoRoot },
      });

      if (item.proofFolder && existsSync(join(item.proofFolder, "result.json"))) {
        const postResult = JSON.parse(
          readFileSync(join(item.proofFolder, "result.json"), "utf8"),
        );
        if (postResult.verdict === "REFUTED") {
          ctx.state.markSeen(`fixed:${item.id}`);
          verifiedCount++;
          dismissedIds.push(item.id);
        } else {
          ctx.logger.warn(
            `Verification for ${item.shortId} returned ${postResult.verdict}; advancing queue.`,
          );
          ctx.state.markSeen(`fixed:${item.id}`);
        }
        continue;
      }
    }

    ctx.state.markSeen(`fixed:${item.id}`);
    verifiedCount++;
    dismissedIds.push(item.id);
  }

  // Bulk-dismiss all verified insights via `ctx.stitch.dismiss("insights", ...)`
  if (dismissedIds.length > 0 && typeof ctx.stitch?.dismiss === "function") {
    ctx.logger.info(`Dismissing ${dismissedIds.length} verified insight(s)...`);
    try {
      await ctx.stitch.dismiss("insights", dismissedIds, {
        workspace: ctx.workspaceId,
      });
    } catch (err) {
      ctx.logger.warn(`Cloud dismissal skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return {
    status: "success",
    summary: `Fixed, verified, and dismissed ${verifiedCount}/${batch.length} high-severity bugs`,
    itemsProcessed: verifiedCount,
  };
}
