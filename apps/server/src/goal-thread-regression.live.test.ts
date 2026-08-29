import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GoalThreadEngine } from "./goal-thread-engine.js";
import { JsonStore } from "./store.js";
import type { Agent, AgentRun } from "./types.js";

/**
 * A large, semantically varied regression dataset (9 topic domains, 35
 * Runs, several deliberately adversarial "trap" cases — subtle sub-genre
 * drift, shallow keyword-similarity, domain overlap) contributed to
 * calibrate and stress-test the engine beyond the small hand-written unit
 * tests. Unlike goal-thread-engine.test.ts, this exercises the REAL Tier 2
 * model (no stub) — a genuine live evaluation, not a hermetic unit test.
 *
 * Gated behind RUN_LIVE_REGRESSION because it makes real network calls to
 * the configured Ark endpoint (cost + latency + requires live credentials)
 * and several cases are explicitly ambiguous by design — they're reported,
 * not hard-asserted, since "did Tier 2 make the judgment call we'd prefer"
 * is exactly what this file is for a human to read and calibrate against,
 * not something to silently gate CI on.
 *
 * Run it with:
 *   RUN_LIVE_REGRESSION=1 npx vitest run src/goal-thread-regression.live.test.ts
 */
interface RegressionVideo {
  id: string;
  runOrder: number;
  category: string;
  taskPrompt: string;
  expectedDecision: "NEW" | "MERGE" | "FORK" | "MERGE_OR_NEW";
  expectedThread: string;
  parentThread?: string;
}

interface RegressionDataset {
  videos: RegressionVideo[];
}

const RUN_LIVE = process.env.RUN_LIVE_REGRESSION === "1";

async function loadDataset(): Promise<RegressionVideo[]> {
  const fixturePath = fileURLToPath(
    new URL("../fixtures/goalthread-regression-dataset.json", import.meta.url),
  );
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as RegressionDataset;
  return [...parsed.videos].sort((a, b) => a.runOrder - b.runOrder);
}

// book-darkacademia-002's expectedThread carries a "(ambiguous)" suffix its
// siblings don't have, even though it's meant to group with them — strip any
// trailing parenthetical before using expectedThread as a grouping key.
function normalizeGroup(expectedThread: string): string {
  return expectedThread.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function makeRun(agent: Agent, prompt: string): AgentRun {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    agentId: agent.id,
    status: "completed",
    prompt,
    output: "done",
    error: null,
    usage: null,
    startedAt: timestamp,
    completedAt: timestamp,
    createdAt: timestamp,
  };
}

describe.skipIf(!RUN_LIVE)("GoalThreadEngine — live regression dataset (real Tier 2)", () => {
  const temporaryDirectories: string[] = [];
  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("classifies the full 35-Run dataset and reports per-entry results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "goalthread-regression-"));
    temporaryDirectories.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const config = loadConfig(process.env);
    expect(
      config.arkApiKey.length > 0,
      "RUN_LIVE_REGRESSION=1 requires ARK_API_KEY / ARK_MODEL to already be configured in the environment",
    ).toBe(true);

    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    const engine = new GoalThreadEngine(config, store);

    // One continuous Agent, matching the dataset's own shape (it has no
    // per-video Agent field — it's testing topic clustering, not the
    // same-Agent-continuation signal specifically).
    const timestamp = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      name: "Regression Agent",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath,
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.mutate((database) => database.agents.push(agent));

    const dataset = await loadDataset();
    // Grouped by expectedThread, not the dataset's `category` field — the
    // dark-academia entries deliberately carry a different `category` from
    // the fantasy entries but the SAME `expectedThread` (that's the point of
    // the sub-genre-drift case: it should merge into the existing reading
    // list, not fork into its own thread just because the topic narrowed).
    const groupAnchor = new Map<string, string>(); // expectedThread -> canonical threadId
    const results: Array<{
      id: string;
      group: string;
      prompt: string;
      expected: string;
      actual: string;
      match: boolean;
      confidence: number;
      note: string;
    }> = [];

    for (const video of dataset) {
      const run = makeRun(agent, video.taskPrompt);
      await store.mutate((database) => database.runs.push(run));
      const decision = await engine.processRun({ run, agent });

      const match =
        video.expectedDecision === "MERGE_OR_NEW"
          ? decision.decision === "MERGE" || decision.decision === "NEW"
          : decision.decision === video.expectedDecision;

      results.push({
        id: video.id,
        group: video.expectedThread,
        prompt: video.taskPrompt,
        expected: video.expectedDecision,
        actual: decision.decision,
        match,
        confidence: decision.confidence,
        note: decision.evidence.semanticNote,
      });

      const groupKey = normalizeGroup(video.expectedThread);
      // Deterministic invariant, independent of model judgment quality: once
      // a group has an anchor thread, every later MERGE in that group must
      // land on that exact same thread (internal consistency of the
      // decisions the engine actually made), and it must never silently
      // land on a different group's anchor thread.
      if (!groupAnchor.has(groupKey) && decision.decision !== "MERGE") {
        groupAnchor.set(groupKey, decision.targetThreadId);
      }
      const anchor = groupAnchor.get(groupKey);
      if (decision.decision === "MERGE" && anchor) {
        expect(
          decision.targetThreadId,
          video.id + ": merged but landed on a different thread than this group's anchor",
        ).toBe(anchor);
      }
      for (const [otherGroup, otherAnchor] of groupAnchor) {
        if (otherGroup === groupKey) continue;
        expect(
          decision.targetThreadId,
          video.id + ": landed on another group's (" + otherGroup + ") anchor thread — cross-domain leak",
        ).not.toBe(otherAnchor);
      }
    }

    // Report: printed, not just asserted — several cases are intentionally
    // ambiguous and meant for a human to read and calibrate against.
    const strict = results.filter((r) => r.expected !== "MERGE_OR_NEW");
    const strictMatches = strict.filter((r) => r.match).length;
    // eslint-disable-next-line no-console
    console.log(
      "\nGoalThread live regression — " +
        strictMatches +
        "/" +
        strict.length +
        " strict matches (" +
        Math.round((strictMatches / strict.length) * 100) +
        "%), " +
        (results.length - strict.length) +
        " ambiguous-by-design case(s) logged only.\n",
    );
    for (const r of results) {
      const flag = r.match ? "  ok " : "MISS ";
      // eslint-disable-next-line no-console
      console.log(
        flag +
          r.id.padEnd(20) +
          " expected=" +
          r.expected.padEnd(12) +
          " actual=" +
          r.actual.padEnd(6) +
          " conf=" +
          r.confidence.toFixed(2) +
          "  " +
          r.note,
      );
    }

    // Hard-gate only on the FORK case (Phase 3's core "must not silently
    // merge on a goal shift" requirement) and on zero cross-domain leaks
    // (already asserted per-iteration above). The rest is reported for
    // calibration, not gated, per the note at the top of this file.
    const forkResult = results.find((r) => r.expected === "FORK");
    expect(forkResult?.actual).toBe("FORK");
  }, 120_000);
});
