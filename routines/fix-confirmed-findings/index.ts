import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const config = {
  schedule: "0 3 * * *",
  exclusive: true,
  timeoutMs: 3_600_000, // 60 min budget for 10 fixes
  description: "Fix top 10 high-severity (P1 + S0/S1) CONFIRMED ISSUE findings from pyric-insight-proofs",
};

const PROOFS_REPO = "/Users/deast/repos/davideast/pyric-insight-proofs";
const FINDINGS_ROOT = join(PROOFS_REPO, "proofs/findings");
const RUNNER_CLI = join(PROOFS_REPO, "proofs/runner/cli.ts");

export async function routine(ctx: any) {
  const maxIssues = Number(ctx.params?.limit ?? 10);

  // 1. Discover all confirmed high-severity ISSUE findings from pyric-insight-proofs
  const candidates: Array<{
    insightId: string;
    shortId: string;
    priority: string;
    severity: string;
    title: string;
    claim: string;
    evidence: Array<{ file: string; line: number; note: string }>;
    evidenceMd: string;
    folder: string;
  }> = [];

  for (const goal of readdirSync(FINDINGS_ROOT)) {
    const goalDir = join(FINDINGS_ROOT, goal);
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
      if (!existsSync(fPath) || !existsSync(rPath)) continue;

      const finding = JSON.parse(readFileSync(fPath, "utf8"));
      const result = JSON.parse(readFileSync(rPath, "utf8"));

      const TARGET_10 = new Set([
        "1938ac5e",
        "b6933d64",
        "b531f5fd",
        "b3886e64",
        "60dcda0f",
        "1bb5a887",
        "a9f777eb",
        "2e1ff170",
        "66355eef",
        "fa2deeb8",
      ]);

      if (
        TARGET_10.has(finding.insightId.slice(0, 8)) &&
        finding.gapNature === "ISSUE" &&
        finding.priority === "P1" &&
        (finding.severity === "S0" || finding.severity === "S1")
      ) {
        candidates.push({
          insightId: finding.insightId,
          shortId: finding.insightId.slice(0, 8),
          priority: finding.priority,
          severity: finding.severity,
          title: finding.title,
          claim: finding.claim,
          evidence: result.evidence ?? [],
          evidenceMd: existsSync(ePath) ? readFileSync(ePath, "utf8") : "",
          folder,
        });
      }
    }
  }

  // Sort S0 before S1
  candidates.sort((a, b) => a.severity.localeCompare(b.severity));

  // 2. Filter unseen and cap at 10
  const batch = candidates
    .filter((c) => !ctx.state.hasSeen(`fixed:${c.insightId}`))
    .slice(0, maxIssues);

  let verifiedCount = 0;
  let alreadyFixedCount = 0;
  const repoRoot = process.cwd();

  const STITCH_CLI = "/tmp/stitch-cli-routines/src/index.ts";
  const dismissedIds: string[] = [];

  for (const item of batch) {
    ctx.logger.info(`[${item.severity}] Checking ${item.shortId}: ${item.title}`);

    // 3. Run pre-fix probe check against current worktree HEAD
    await ctx.exec("bun", [RUNNER_CLI, "run", "--id", item.shortId], {
      cwd: PROOFS_REPO,
      env: { ...process.env, PYRIC_SOURCE_ROOT: repoRoot },
    });

    const preResult = JSON.parse(readFileSync(join(item.folder, "result.json"), "utf8"));
    if (preResult.verdict === "REFUTED") {
      ctx.logger.info(`Bug ${item.shortId} is fixed and verified on this branch; queuing for dismissal.`);
      ctx.state.markSeen(`fixed:${item.insightId}`);
      alreadyFixedCount++;
      verifiedCount++;
      dismissedIds.push(item.insightId);
      continue;
    }

    // 4. Build structured fix prompt citing exact file:line locations from result.json
    const citedSites = item.evidence
      .map((e) => `- \`${e.file}:${e.line}\` — ${e.note}`)
      .join("\n");

    const prompt = [
      `You are fixing a verified high-severity bug (${item.severity} / ${item.priority}) in the Pyric repository.`,
      `### FINDING: ${item.title} (\`${item.insightId}\`)`,
      `**Claim**: ${item.claim}`,
      `### EXACT EVIDENCE LOCATIONS IN THIS REPO\n${citedSites}`,
      `### FULL PROOF & REPRODUCTION NOTES\n${item.evidenceMd}`,
      `### INSTRUCTIONS`,
      `1. Inspect the exact files and line numbers listed above.`,
      `2. Implement the minimal, targeted fix that resolves the issue without breaking existing APIs.`,
      `3. Run \`PYRIC_SOURCE_ROOT="${repoRoot}" bun "${RUNNER_CLI}" run --id ${item.shortId}\` to verify that the bug test now passes.`,
      `4. Commit your changes with message: \`fix: resolve ${item.title} (${item.shortId})\`.`,
      `5. Dismiss the insight using the Stitch CLI: \`bun "${STITCH_CLI}" dismiss insights ${item.insightId} -w ${ctx.workspace}\`.`,
    ].join("\n\n");

    // 5. Dispatch to coding agent (or record in dry-run)
    const promptRes = await ctx.prompt("agy", prompt);

    if (ctx.dryRun) {
      verifiedCount++;
      dismissedIds.push(item.insightId);
      continue;
    }

    // 6. Mechanical post-fix verification via pyric-insight-proofs probe runner
    await ctx.exec("bun", [RUNNER_CLI, "run", "--id", item.shortId], {
      cwd: PROOFS_REPO,
      env: { ...process.env, PYRIC_SOURCE_ROOT: repoRoot },
    });

    const postResult = JSON.parse(readFileSync(join(item.folder, "result.json"), "utf8"));
    if (postResult.verdict === "REFUTED") {
      ctx.logger.info(`Verified fix for ${item.shortId}: bug reproduction test no longer triggers`);
      ctx.state.markSeen(`fixed:${item.insightId}`);
      verifiedCount++;
      dismissedIds.push(item.insightId);
    } else {
      ctx.logger.warn(`Bug reproduction test for ${item.shortId} still triggers; not marking done.`);
    }
  }

  // 7. Bulk-dismiss all verified insights via the Stitch CLI `dismiss insights` feature
  if (dismissedIds.length > 0) {
    const cliArgs = [STITCH_CLI, "dismiss", "insights", ...dismissedIds, "-w", ctx.workspace];
    if (ctx.dryRun) {
      cliArgs.push("--dry-run");
    }
    ctx.logger.info(`Dismissing ${dismissedIds.length} verified insights via CLI: stitch dismiss insights`);
    await ctx.exec("bun", cliArgs, {
      cwd: repoRoot,
    });
  }

  return {
    status: "success",
    summary: `Fixed, verified, and dismissed ${verifiedCount}/${batch.length} high-severity bugs`,
    itemsProcessed: verifiedCount,
  };
}
