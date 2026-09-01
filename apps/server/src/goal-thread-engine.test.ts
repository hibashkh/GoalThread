import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { ArkCallError } from "./ark-client.js";
import { GoalThreadEngine, type Tier2Result } from "./goal-thread-engine.js";
import { JsonStore } from "./store.js";
import type { Agent, AgentRun } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeStore(): Promise<{ store: JsonStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "goalthread-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return { store, root };
}

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...overrides,
  });
}

async function makeAgent(root: string, name = "Agent"): Promise<Agent> {
  const id = randomUUID();
  const workspacePath = path.join(root, "workspaces", id);
  await mkdir(workspacePath, { recursive: true });
  const timestamp = new Date().toISOString();
  const agent: Agent = {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return agent;
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

async function seedDatabase(store: JsonStore, agents: Agent[], runs: AgentRun[]): Promise<void> {
  await store.mutate((database) => {
    database.agents.push(...agents);
    database.runs.push(...runs);
  });
}

describe("GoalThreadEngine — Tier 1 (deterministic) path", () => {
  it("creates a new thread when no Tier 1 signal matches anything", async () => {
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agent = await makeAgent(root);
    const run = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agent], [run]);

    const decision = await engine.processRun({ run, agent });

    expect(decision.decision).toBe("NEW");
    expect(decision.confidence).toBe(1);
    const threads = engine.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.keyEntities).toContain("Tokyo");
    expect(threads[0]?.runIds).toEqual([run.id]);
  });

  it("merges a Run that explicitly references prior output and shares an entity", async () => {
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agentA = await makeAgent(root, "Agent A");
    const agentB = await makeAgent(root, "Agent B");
    const runA = makeRun(agentA, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agentA, agentB], [runA]);
    await engine.processRun({ run: runA, agent: agentA });

    const runB = makeRun(agentB, "Which of those Tokyo spots are near Shibuya?");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent: agentB });

    expect(decision.decision).toBe("MERGE");
    expect(decision.evidence.explicitReference).toBe(true);
    expect(decision.evidence.sharedEntities).toContain("Tokyo");
    const threads = engine.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.runIds).toEqual([runA.id, runB.id]);
  });

  it("merges on workspace overlap even without an explicit reference phrase", async () => {
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agentA = await makeAgent(root, "Agent A");
    const agentB = await makeAgent(root, "Agent B");
    // Shared fixture content dropped into both workspaces — simulates the
    // same underlying saved-video source material being reused.
    await writeFile(path.join(agentA.workspacePath, "tokyo-videos.json"), "[]", "utf8");
    await writeFile(path.join(agentB.workspacePath, "tokyo-videos.json"), "[]", "utf8");
    const runA = makeRun(agentA, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agentA, agentB], [runA]);
    await engine.processRun({ run: runA, agent: agentA });

    const runB = makeRun(agentB, "Build a 3-day Tokyo itinerary.");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent: agentB });

    expect(decision.decision).toBe("MERGE");
    expect(decision.evidence.workspaceOverlap).toBe(true);
  });

  it("keeps clearly unrelated Runs in separate threads", async () => {
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agentA = await makeAgent(root, "Agent A");
    const agentB = await makeAgent(root, "Agent B");
    const runA = makeRun(agentA, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agentA, agentB], [runA]);
    await engine.processRun({ run: runA, agent: agentA });

    const runB = makeRun(agentB, "Give me a 4-day beginner gym routine.");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent: agentB });

    expect(decision.decision).toBe("NEW");
    expect(engine.listThreads()).toHaveLength(2);
  });

  it("forks instead of silently merging on an explicit goal shift", async () => {
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agent], [runA]);
    const first = await engine.processRun({ run: runA, agent });
    const tokyoThreadId = first.targetThreadId;

    const runB = makeRun(agent, "Actually forget Tokyo, I'm going to Seoul instead.");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(decision.decision).toBe("FORK");
    expect(decision.evidence.goalShiftDetected).toBe(true);

    const tokyoThread = engine.getThread(tokyoThreadId);
    const seoulThread = engine.getThread(decision.targetThreadId);
    expect(tokyoThread?.status).toBe("CLOSED");
    expect(seoulThread?.status).toBe("ACTIVE");
    expect(seoulThread?.parentThreadId).toBe(tokyoThreadId);
  });

  it("forks on a goal shift even when the whole message is typed lowercase", async () => {
    // Regression test: a real user typed this exact lowercase phrasing live
    // and it silently merged instead of forking, because entity extraction
    // only recognized capitalized words — an all-lowercase message has none,
    // so there was never a "new entity" to fork onto even though the
    // goal-shift phrasing was clearly there.
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agent], [runA]);
    const first = await engine.processRun({ run: runA, agent });
    const tokyoThreadId = first.targetThreadId;

    const runB = makeRun(agent, "actually forget tokyo, im going to seoul instead");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(decision.decision).toBe("FORK");
    const tokyoThread = engine.getThread(tokyoThreadId);
    const seoulThread = engine.getThread(decision.targetThreadId);
    expect(tokyoThread?.status).toBe("CLOSED");
    expect(seoulThread?.status).toBe("ACTIVE");
  });

  it("forks on a goal shift with mixed capitalization (old goal capitalized, new goal lowercase)", async () => {
    // Second real regression: "Tokyo" stayed capitalized (it's the word
    // already established in the thread) but "seoul" — the actually new
    // part — was typed lowercase and missing "to" before it. The first
    // lowercase-only fix didn't cover this since the message still has a
    // capitalized word ("Tokyo"), which used to force the strict
    // capitalized-only extraction path and miss "seoul" entirely.
    const { store, root } = await makeStore();
    const engine = new GoalThreadEngine(makeConfig(), store);
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agent], [runA]);
    const first = await engine.processRun({ run: runA, agent });
    const tokyoThreadId = first.targetThreadId;

    const runB = makeRun(agent, "Actually forget Tokyo im going seoul instead");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(decision.decision).toBe("FORK");
    const tokyoThread = engine.getThread(tokyoThreadId);
    const seoulThread = engine.getThread(decision.targetThreadId);
    expect(tokyoThread?.status).toBe("CLOSED");
    expect(seoulThread?.status).toBe("ACTIVE");
  });
});

describe("GoalThreadEngine — Tier 2 (model-assisted) path", () => {
  it("invokes Tier 2 on ambiguous signals and follows its verdict to merge", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Research good coffee shops in Lisbon.");
    let tier2Calls = 0;
    const engine = new GoalThreadEngine(makeConfig(), store, {
      tier2: async () => {
        tier2Calls += 1;
        return { related_thread_id: null, goal_shift: false, reason: "unrelated topic" };
      },
    });
    await seedDatabase(store, [agent], [runA]);
    const first = await engine.processRun({ run: runA, agent });

    // Same Agent continuing (1 signal) but zero entities and no
    // explicit-reference keyword — exactly the plain-follow-up-chat case
    // that must escalate to Tier 2 rather than being auto-classified by
    // Tier 1 alone (one signal isn't enough on its own to merge or to stay
    // separate).
    const runB = makeRun(agent, "What should we tackle after this?");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(tier2Calls).toBe(1);
    expect(decision.decision).toBe("NEW");
    expect(engine.listThreads()).toHaveLength(2);
    expect(first.decision).toBe("NEW");
  });

  it("treats a same-Agent follow-up plus one other signal as a strong match with no model call", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Research good coffee shops in Lisbon.");
    let tier2Calls = 0;
    const engine = new GoalThreadEngine(makeConfig(), store, {
      tier2: async () => {
        tier2Calls += 1;
        return { related_thread_id: null, goal_shift: false, reason: "unused" };
      },
    });
    await seedDatabase(store, [agent], [runA]);
    await engine.processRun({ run: runA, agent });

    // Same Agent continuing + an explicit-reference keyword ("continue") —
    // two agreeing signals, so this must merge immediately without paying
    // for a Tier 2 call, even though it shares no entity with the thread.
    // This is the actual fix for plain chat over-splitting into new threads.
    const runB = makeRun(agent, "Continue with the next step for the trip.");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(decision.decision).toBe("MERGE");
    expect(tier2Calls).toBe(0);
    expect(engine.listThreads()).toHaveLength(1);
  });

  it("follows a Tier 2 merge verdict", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Research good coffee shops in Lisbon.");
    const engine = new GoalThreadEngine(makeConfig(), store, {
      tier2: async ({ userPrompt }) => {
        const threadIdMatch = /Thread id: (\S+)/.exec(userPrompt);
        return {
          related_thread_id: threadIdMatch?.[1] ?? null,
          goal_shift: false,
          reason: "continues the same research effort",
        } satisfies Tier2Result;
      },
    });
    await seedDatabase(store, [agent], [runA]);
    await engine.processRun({ run: runA, agent });

    const runB = makeRun(agent, "What should we tackle after this?");
    await store.mutate((database) => database.runs.push(runB));
    const decision = await engine.processRun({ run: runB, agent });

    expect(decision.decision).toBe("MERGE");
    expect(engine.listThreads()).toHaveLength(1);
  });

  it("falls back to Tier 1 signals gracefully when the model call fails", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Research good coffee shops in Lisbon.");
    const engine = new GoalThreadEngine(makeConfig(), store, {
      tier2: async () => {
        throw new ArkCallError("simulated provider outage");
      },
    });
    await seedDatabase(store, [agent], [runA]);
    await engine.processRun({ run: runA, agent });

    const runB = makeRun(agent, "What should we tackle after this?");
    await store.mutate((database) => database.runs.push(runB));

    // Tier 2 is unavailable, so the engine falls back to the best Tier 1
    // signal it has (the "continue" reference) rather than blocking the Run
    // — a weaker, lower-confidence merge, clearly logged as a fallback.
    const decision = await engine.processRun({ run: runB, agent });
    expect(decision.decision).toBe("MERGE");
    expect(decision.confidence).toBeLessThan(0.9);
    expect(decision.evidence.semanticNote).toContain("Tier 2 unavailable");
    expect(engine.listThreads()).toHaveLength(1);
  });

  it("degrades gracefully via GOALTHREAD_FORCE_TIER2_FAILURE without touching the real Tier 2 client", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const runA = makeRun(agent, "Research good coffee shops in Lisbon.");
    let realTier2Calls = 0;
    const engine = new GoalThreadEngine(makeConfig(), store, {
      tier2: async () => {
        realTier2Calls += 1;
        return { related_thread_id: null, goal_shift: false, reason: "unused" };
      },
    });
    await seedDatabase(store, [agent], [runA]);
    await engine.processRun({ run: runA, agent });

    const runB = makeRun(agent, "What should we tackle after this?");
    await store.mutate((database) => database.runs.push(runB));

    process.env.GOALTHREAD_FORCE_TIER2_FAILURE = "1";
    try {
      const decision = await engine.processRun({ run: runB, agent });
      expect(decision.decision).toBe("MERGE");
      expect(decision.evidence.semanticNote).toContain("Simulated Tier 2 outage");
      expect(realTier2Calls).toBe(0);
    } finally {
      delete process.env.GOALTHREAD_FORCE_TIER2_FAILURE;
    }
  });

  it("never throws even if the engine hits an unexpected internal error", async () => {
    const { store, root } = await makeStore();
    const agent = await makeAgent(root);
    const run = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    // A store pointed at a directory that cannot be written to simulates an
    // unexpected internal failure without relying on implementation details.
    const brokenStore = new JsonStore(path.join(root, "nonexistent", "sub", "db.json"));
    const engine = new GoalThreadEngine(makeConfig(), brokenStore);

    const decision = await engine.processRun({ run, agent });
    expect(decision.decision).toBe("NEW");
    expect(decision.confidence).toBe(0);
  });
});

describe("GoalThreadEngine — context isolation across fork/close", () => {
  it("never assembles a forked thread's context from its closed parent's Runs", async () => {
    const { store, root } = await makeStore();
    const capturedPrompts: string[] = [];
    const engine = new GoalThreadEngine(makeConfig(), store, {
      // A real Tier 2 client would only ever see what's in this prompt, so
      // capturing it lets us assert the closed parent's Runs never reached
      // even the model-assisted path.
      tier2: async ({ userPrompt }) => {
        capturedPrompts.push(userPrompt);
        const threadIdMatch = /Thread id: (\S+)/.exec(userPrompt);
        return {
          related_thread_id: threadIdMatch?.[1] ?? null,
          goal_shift: false,
          reason: "continues the only open thread",
        } satisfies Tier2Result;
      },
    });
    const agent = await makeAgent(root);

    const runA = makeRun(agent, "Extract restaurants from my saved Tokyo travel videos.");
    await seedDatabase(store, [agent], [runA]);
    await engine.processRun({ run: runA, agent });

    const runB = makeRun(agent, "Which of those are near Shibuya?");
    await store.mutate((database) => database.runs.push(runB));
    await engine.processRun({ run: runB, agent });

    const runC = makeRun(agent, "Build a 3-day itinerary from those places.");
    await store.mutate((database) => database.runs.push(runC));
    await engine.processRun({ run: runC, agent });

    const [tokyoThread] = engine.listThreads();
    expect(tokyoThread?.runIds).toEqual([runA.id, runB.id, runC.id]);

    // Goal shift: fork Seoul out of Tokyo.
    const runD = makeRun(agent, "Actually forget Tokyo, I'm going to Seoul instead.");
    await store.mutate((database) => database.runs.push(runD));
    const forkDecision = await engine.processRun({ run: runD, agent });
    const seoulThreadId = forkDecision.targetThreadId;
    const tokyoThreadId = tokyoThread!.id;

    // Attack: a Seoul-thread Run tries to pull in Tokyo's "prior output".
    const runE = makeRun(agent, "Show me the restaurants we found earlier, near Shibuya.");
    await store.mutate((database) => database.runs.push(runE));
    await engine.processRun({ run: runE, agent });

    const seoulContext = engine.getThreadContext(seoulThreadId);
    const tokyoContext = engine.getThreadContext(tokyoThreadId);

    // Seoul's assembled context must contain only Seoul's own Runs.
    const seoulRunIds = seoulContext.runs.map((run) => run.id);
    expect(seoulRunIds).not.toContain(runA.id);
    expect(seoulRunIds).not.toContain(runB.id);
    expect(seoulRunIds).not.toContain(runC.id);
    // runE's own wording ("earlier", "Shibuya") is expected to appear here —
    // it's the new task's own text. What must NOT appear is Tokyo's own,
    // separately-recorded Run text (runB literally asked about Shibuya).
    expect(seoulContext.runs.some((run) => run.id === runB.id)).toBe(false);
    expect(seoulContext.runs.map((run) => run.prompt)).not.toContain(runB.prompt);
    expect(seoulContext.thread.runIds).not.toContain(runA.id);

    // Tokyo's own context is untouched by the fork or the later Seoul Run.
    expect(tokyoContext.runs.map((run) => run.id)).toEqual([runA.id, runB.id, runC.id]);
    expect(tokyoContext.thread.status).toBe("CLOSED");

    // The Seoul Run itself must not have silently merged back into the
    // closed Tokyo thread just because it referenced "earlier" restaurants.
    // (This particular Run is a strong Tier 1 match on its own — explicit
    // reference + same-Agent continuation — so it never needs Tier 2 at all;
    // that's the correct, cheaper outcome, and it's exercised below with a
    // follow-up that genuinely is ambiguous.)
    const runEDecision = engine.getDecisionForRun(runE.id);
    expect(runEDecision?.targetThreadId).not.toBe(tokyoThreadId);
    expect(runEDecision?.targetThreadId).toBe(seoulThreadId);

    // Follow-up with zero entities and no reference keyword — only
    // same-Agent continuation fires, a single signal that must escalate to
    // Tier 2. This is the real boundary a live model call would see, so
    // it's the meaningful place to prove isolation: even though Seoul's own
    // Run history literally contains the word "Tokyo" (runD's own wording,
    // "forget Tokyo"), the closed thread's separate id and its Runs' text
    // must never appear in what gets sent to the model.
    const runF = makeRun(agent, "What else should we check before booking anything?");
    await store.mutate((database) => database.runs.push(runF));
    const runFDecision = await engine.processRun({ run: runF, agent });

    expect(runFDecision.targetThreadId).toBe(seoulThreadId);
    const lastPrompt = capturedPrompts.at(-1);
    expect(lastPrompt).toBeDefined();
    expect(lastPrompt).not.toContain(tokyoThreadId);
    expect(lastPrompt).not.toContain(runA.prompt);
    expect(lastPrompt).not.toContain(runB.prompt);
    expect(lastPrompt).not.toContain(runC.prompt);
  });
});
