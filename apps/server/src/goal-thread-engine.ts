import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { ArkCallError, callArkStructured } from "./ark-client.js";
import {
  contradictingEntities,
  deriveFallbackTitle,
  extractEntities,
  extractEntitiesLenient,
  hasExplicitReference,
  hasGoalShiftSignal,
  sharedEntities,
} from "./goal-thread-signals.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  GoalThread,
  ThreadDecision,
  ThreadDecisionEvidence,
} from "./types.js";

const now = () => new Date().toISOString();

// Files every Agent workspace starts with (see WorkspaceManager.create). They
// exist regardless of task content, so they must never count as "shared
// workspace content" between two Agents.
const PLATFORM_WORKSPACE_FILES = new Set(["AGENTS.md", "README.md", ".gitignore"]);

export interface Tier2Result {
  related_thread_id: string | null;
  goal_shift: boolean;
  reason: string;
}

export type Tier2Client = (options: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<Tier2Result>;

export interface ProcessRunInput {
  run: AgentRun;
  agent: Agent;
}

export interface ThreadContext {
  thread: GoalThread;
  runs: AgentRun[];
}

const TIER2_SCHEMA = {
  type: "object",
  properties: {
    related_thread_id: {
      type: ["string", "null"],
      description: "id of the existing thread this Run belongs to, or null if it starts a new goal",
    },
    goal_shift: {
      type: "boolean",
      description: "true if the task text abandons the goal of related_thread_id in favor of a new one",
    },
    reason: {
      type: "string",
      description: "one sentence, plain language, explaining the verdict",
    },
  },
  required: ["related_thread_id", "goal_shift", "reason"],
  additionalProperties: false,
} as const;

const TIER2_SYSTEM_PROMPT = [
  "You classify whether a new Agent task belongs to an existing goal thread.",
  "You will be given short summaries of currently open goal threads, then the new task text.",
  "Decide which thread (if any) the new task continues, and whether it represents a goal change",
  "away from that thread rather than a continuation of it.",
  "Respond only through the provided JSON schema.",
  "",
  "Rules:",
  "- related_thread_id must be one of the listed thread ids, or null if the task starts an unrelated goal.",
  "- goal_shift is true only when the task explicitly abandons or replaces the goal of related_thread_id",
  "  (e.g. \"forget X, do Y instead\"), not merely when it adds a new detail to the same goal.",
  "- Keep reason to one plain-language sentence.",
].join("\n");

function defaultTier2Client(config: AppConfig): Tier2Client {
  return async ({ systemPrompt, userPrompt }) =>
    callArkStructured<Tier2Result>(config, {
      systemPrompt,
      userPrompt,
      schemaName: "goal_thread_decision",
      schema: TIER2_SCHEMA,
    });
}

async function listWorkspaceContentFiles(workspacePath: string): Promise<string[]> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && !PLATFORM_WORKSPACE_FILES.has(name));
  } catch {
    return [];
  }
}

interface ThreadSignals {
  thread: GoalThread;
  shared: string[];
  workspaceOverlap: boolean;
  explicitReference: boolean;
  // This thread's most recent Run came from the same Agent as the Run being
  // classified — i.e. this is very likely the same live conversation
  // continuing on the platform's own resumable Codex session, not a
  // coincidence. See isSameAgentContinuation.
  sameAgentContinuation: boolean;
  score: number;
}

// Any two of the four Tier 1 signals agreeing is a strong match and merges
// immediately with no model call; a single signal alone is ambiguous and
// falls through to Tier 2. (Deliberately not a weighted score — see the
// build instructions' note against inventing an uncalibrated formula.)
function isStrongMatch(signals: ThreadSignals): boolean {
  return countAgreeingSignals(signals) >= 2;
}

function countAgreeingSignals(signals: {
  workspaceOverlap: boolean;
  explicitReference: boolean;
  shared: string[];
  sameAgentContinuation: boolean;
}): number {
  return (
    (signals.workspaceOverlap ? 1 : 0) +
    (signals.explicitReference ? 1 : 0) +
    (signals.shared.length > 0 ? 1 : 0) +
    (signals.sameAgentContinuation ? 1 : 0)
  );
}

// A thread's most recent Run having come from this same Agent is strong,
// platform-native evidence of continuity: each Agent already keeps one
// persistent, resumable Codex session (see agent-service.ts), so a follow-up
// message on the same Agent is very likely still part of the conversation
// that opened this thread — even when it repeats no entity and uses no
// reference keyword at all (e.g. "but can you make it a 3-day version").
// `thread.runIds` is append-only (merge/createNew/fork only ever push), so
// the last id is always the most recent Run.
function isSameAgentContinuation(
  thread: GoalThread,
  agentId: string,
  allRuns: AgentRun[],
): boolean {
  const lastRunId = thread.runIds.at(-1);
  if (!lastRunId) return false;
  const lastRun = allRuns.find((run) => run.id === lastRunId);
  return lastRun?.agentId === agentId;
}

function titleFromEntities(entities: string[], prompt: string): string {
  if (entities.length > 0) {
    return entities.slice(0, 2).join(" & ");
  }
  return deriveFallbackTitle(prompt);
}

export class GoalThreadEngine {
  private readonly tier2: Tier2Client;
  private readonly workspacesByAgentId = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    options?: { tier2?: Tier2Client },
  ) {
    this.tier2 = options?.tier2 ?? defaultTier2Client(config);
  }

  /**
   * Returns the Runs belonging to exactly this thread — never a parent's or
   * sibling's. This is the single seam every context-assembly path (Tier 2
   * prompt building, the `/goal-threads/:id/runs` route) must go through, so
   * a forked or closed thread's data can never leak forward.
   */
  getThreadContext(threadId: string): ThreadContext {
    const database = this.store.snapshot();
    const thread = database.goalThreads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error("Goal thread not found: " + threadId);
    }
    const ownRunIds = new Set(thread.runIds);
    const runs = database.runs.filter((run) => ownRunIds.has(run.id));
    return { thread, runs };
  }

  getThread(threadId: string): GoalThread | undefined {
    return this.store.snapshot().goalThreads.find((item) => item.id === threadId);
  }

  listThreads(): GoalThread[] {
    return this.store
      .snapshot()
      .goalThreads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getDecisionForRun(runId: string): ThreadDecision | undefined {
    return this.store.snapshot().threadDecisions.find((item) => item.runId === runId);
  }

  /**
   * Runs once per completed Run. Never throws — any internal failure is
   * caught and recorded as a conservative NEW-thread decision so a Run's
   * own completion is never affected by this engine.
   */
  async processRun(input: ProcessRunInput): Promise<ThreadDecision> {
    try {
      return await this.classifyAndPersist(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback: ThreadDecision = {
        id: randomUUID(),
        runId: input.run.id,
        agentId: input.agent.id,
        decision: "NEW",
        confidence: 0,
        targetThreadId: "",
        evidence: {
          sharedEntities: [],
          workspaceOverlap: false,
          explicitReference: false,
          semanticNote:
            "GoalThreadEngine failed unexpectedly (" +
            message +
            "); the Run completed normally regardless.",
          goalShiftDetected: false,
        },
        createdAt: now(),
      };
      try {
        // Best-effort persistence — if the store itself is why we're here,
        // this can also fail; the caller must still get a decision back.
        await this.store.mutate((database) => database.threadDecisions.push(fallback));
      } catch {
        // Swallow: persistence is broken, but processRun must never throw.
      }
      return fallback;
    }
  }

  private async classifyAndPersist(input: ProcessRunInput): Promise<ThreadDecision> {
    const { run, agent } = input;
    const text = run.prompt;
    const entities = extractEntities(text);
    const explicitReference = hasExplicitReference(text);
    const goalShift = hasGoalShiftSignal(text);

    const database = this.store.snapshot();
    const activeThreads = database.goalThreads.filter((thread) => thread.status === "ACTIVE");

    const currentWorkspaceFiles = await listWorkspaceContentFiles(agent.workspacePath);
    const signals: ThreadSignals[] = [];
    for (const thread of activeThreads) {
      const shared = sharedEntities(entities, thread.keyEntities);
      const workspaceOverlap = await this.hasWorkspaceOverlap(
        database.runs,
        thread,
        agent.id,
        currentWorkspaceFiles,
      );
      const sameAgentContinuation = isSameAgentContinuation(thread, agent.id, database.runs);
      const score =
        (workspaceOverlap ? 2 : 0) +
        (explicitReference ? 2 : 0) +
        shared.length +
        (sameAgentContinuation ? 2 : 0);
      signals.push({
        thread,
        shared,
        workspaceOverlap,
        explicitReference,
        sameAgentContinuation,
        score,
      });
    }

    signals.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.thread.updatedAt.localeCompare(left.thread.updatedAt);
    });
    const best = signals[0] && signals[0].score > 0 ? signals[0] : undefined;

    // Lenient (case-insensitive) extraction specifically here: this is only
    // ever consulted once the goal-shift phrase has already matched — a
    // strong, deliberate signal — so it's safe to catch a new goal typed in
    // lowercase even when other words in the same message (e.g. the old
    // goal's name) happen to be capitalized. See extractEntitiesLenient.
    const contradicting = best
      ? contradictingEntities(extractEntitiesLenient(text), best.thread.keyEntities)
      : [];
    if (goalShift && best && contradicting.length > 0) {
      return this.fork(input, best.thread, contradicting, {
        sharedEntities: best.shared,
        workspaceOverlap: best.workspaceOverlap,
        explicitReference: best.explicitReference,
        semanticNote:
          "FORKED from " +
          best.thread.title +
          " — goal shift detected (\"" +
          contradicting.join(", ") +
          "\" replaces the prior goal).",
        goalShiftDetected: true,
      });
    }

    if (best && isStrongMatch(best)) {
      return this.merge(
        input,
        best.thread,
        {
          sharedEntities: best.shared,
          workspaceOverlap: best.workspaceOverlap,
          explicitReference: best.explicitReference,
          semanticNote: this.mergeNote(best),
          goalShiftDetected: false,
        },
        best.sameAgentContinuation,
      );
    }

    if (!best) {
      return this.createNew(input, entities, {
        sharedEntities: [],
        workspaceOverlap: false,
        explicitReference,
        semanticNote: "No Tier 1 signal matched an open thread — started a new thread.",
        goalShiftDetected: false,
      });
    }

    // Weak/mixed Tier 1 signal: escalate to Tier 2.
    return this.classifyWithTier2(input, entities, signals.filter((s) => s.score > 0));
  }

  private async hasWorkspaceOverlap(
    allRuns: AgentRun[],
    thread: GoalThread,
    currentAgentId: string,
    currentWorkspaceFiles: string[],
  ): Promise<boolean> {
    if (currentWorkspaceFiles.length === 0) return false;
    const threadRunIds = new Set(thread.runIds);
    const otherAgentIds = new Set(
      allRuns
        .filter((run) => threadRunIds.has(run.id) && run.agentId !== currentAgentId)
        .map((run) => run.agentId),
    );
    for (const agentId of otherAgentIds) {
      const workspacePath = await this.workspacePathForAgent(agentId);
      if (!workspacePath) continue;
      const otherFiles = await listWorkspaceContentFiles(workspacePath);
      if (otherFiles.some((name) => currentWorkspaceFiles.includes(name))) {
        return true;
      }
    }
    return false;
  }

  private async workspacePathForAgent(agentId: string): Promise<string | undefined> {
    if (!this.workspacesByAgentId.has(agentId)) {
      const agent = this.store.snapshot().agents.find((item) => item.id === agentId);
      this.workspacesByAgentId.set(agentId, agent?.workspacePath ?? "");
    }
    return this.workspacesByAgentId.get(agentId) || undefined;
  }

  private mergeNote(signals: ThreadSignals): string {
    const parts: string[] = [];
    if (signals.shared.length > 0) parts.push("shared entities: " + signals.shared.join(", "));
    if (signals.workspaceOverlap) parts.push("same workspace content");
    if (signals.explicitReference) parts.push("referenced prior output");
    if (signals.sameAgentContinuation) parts.push("continuing this Agent's own session");
    return (
      "MERGED into " + signals.thread.title + " — " + (parts.join("; ") || "matched on Tier 1 signals") + "."
    );
  }

  // Cap on how many candidate threads get offered to Tier 2, to bound prompt
  // size against a pathological number of open threads. Live regression
  // testing tried raising this from 3 to 12 to fix a rare long-range
  // disambiguation miss (an older, dormant thread excluded from the
  // candidate list by recency truncation) — but a wider candidate pool
  // measurably made the common case worse (38/40 vs 39/40 strict matches,
  // with new cross-domain leaks from shallow "these are all book
  // recommendations"-style over-merging). Kept at 3: the narrow edge case
  // it doesn't solve is documented as a known limitation in the README
  // rather than "fixed" at the cost of the common case regressing.
  private static readonly MAX_TIER2_CANDIDATES = 3;

  private async classifyWithTier2(
    input: ProcessRunInput,
    entities: string[],
    candidates: ThreadSignals[],
  ): Promise<ThreadDecision> {
    const topCandidates = candidates.slice(0, GoalThreadEngine.MAX_TIER2_CANDIDATES);

    if (!isArkConfigured(this.config)) {
      return this.tier1FallbackDecision(input, entities, topCandidates, "Ark is not configured");
    }

    // Static content (system prompt, schema, rules) first, dynamic content
    // (thread summaries, new task text) last — lets ModelArk's automatic
    // prompt-prefix caching apply across repeated Tier 2 calls.
    const userPrompt = this.buildTier2UserPrompt(input.run.prompt, topCandidates);

    try {
      // Demo/testing-only fault injection: Codex's own model access (via
      // codex-home/config.toml) shares this same ARK_API_KEY, so breaking
      // the real key to demo Tier 2 failing would also break every Codex
      // Run — not the isolated "GoalThread degrades gracefully" case this
      // is meant to show. This flag simulates a Tier 2 outage without
      // touching Codex at all, so the Run itself still completes normally.
      // See README's failure/degraded-case demo script.
      if (process.env.GOALTHREAD_FORCE_TIER2_FAILURE === "1") {
        throw new ArkCallError(
          "Simulated Tier 2 outage (GOALTHREAD_FORCE_TIER2_FAILURE=1)",
        );
      }
      const result = await this.tier2({
        systemPrompt: TIER2_SYSTEM_PROMPT,
        userPrompt,
      });
      return this.applyTier2Result(input, entities, topCandidates, result);
    } catch (error) {
      const message = error instanceof ArkCallError ? error.message : String(error);
      return this.tier1FallbackDecision(input, entities, topCandidates, message);
    }
  }

  private buildTier2UserPrompt(taskText: string, candidates: ThreadSignals[]): string {
    const summaries = candidates.map((signal) => {
      // Scoped strictly to this thread's own Runs — see getThreadContext.
      const context = this.getThreadContext(signal.thread.id);
      const recentPrompts = context.runs
        .slice(-3)
        .map((run) => "  - " + run.prompt)
        .join("\n");
      return [
        "Thread id: " + signal.thread.id,
        "Title: " + signal.thread.title,
        "Key entities: " + signal.thread.keyEntities.join(", "),
        "Recent tasks in this thread:",
        recentPrompts || "  (none)",
      ].join("\n");
    });
    return (
      "Open threads:\n\n" +
      summaries.join("\n\n") +
      "\n\nNew task text:\n" +
      taskText
    );
  }

  private async applyTier2Result(
    input: ProcessRunInput,
    entities: string[],
    candidates: ThreadSignals[],
    result: Tier2Result,
  ): Promise<ThreadDecision> {
    const matchedCandidate = result.related_thread_id
      ? candidates.find((c) => c.thread.id === result.related_thread_id)
      : undefined;
    const target = matchedCandidate?.thread;

    if (target && result.goal_shift) {
      // Lenient extraction here too — see the comment on the Tier 1 fork
      // path above for why (mixed-capitalization goal-shift messages).
      const lenientEntities = extractEntitiesLenient(input.run.prompt);
      const newGoalEntities = contradictingEntities(lenientEntities, target.keyEntities);
      return this.fork(input, target, newGoalEntities.length > 0 ? newGoalEntities : entities, {
        sharedEntities: sharedEntities(entities, target.keyEntities),
        workspaceOverlap: false,
        explicitReference: false,
        semanticNote: "FORKED from " + target.title + " (Tier 2): " + result.reason,
        goalShiftDetected: true,
      });
    }
    if (target) {
      return this.merge(
        input,
        target,
        {
          sharedEntities: sharedEntities(entities, target.keyEntities),
          workspaceOverlap: false,
          explicitReference: false,
          semanticNote: "MERGED into " + target.title + " (Tier 2): " + result.reason,
          goalShiftDetected: false,
        },
        matchedCandidate?.sameAgentContinuation,
      );
    }
    return this.createNew(input, entities, {
      sharedEntities: [],
      workspaceOverlap: false,
      explicitReference: false,
      semanticNote: "Tier 2 found no related thread: " + result.reason,
      goalShiftDetected: false,
    });
  }

  private tier1FallbackDecision(
    input: ProcessRunInput,
    entities: string[],
    candidates: ThreadSignals[],
    failureReason: string,
  ): Promise<ThreadDecision> {
    const best = candidates[0];
    if (!best) {
      return this.createNew(input, entities, {
        sharedEntities: [],
        workspaceOverlap: false,
        explicitReference: false,
        semanticNote: "Tier 2 unavailable (" + failureReason + "); no Tier 1 signal matched, started a new thread.",
        goalShiftDetected: false,
      });
    }
    return this.merge(
      input,
      best.thread,
      {
        sharedEntities: best.shared,
        workspaceOverlap: best.workspaceOverlap,
        explicitReference: best.explicitReference,
        semanticNote:
          "Tier 2 unavailable (" +
          failureReason +
          "); fell back to the best Tier 1 match: " +
          this.mergeNote(best),
        goalShiftDetected: false,
      },
      best.sameAgentContinuation,
    );
  }

  private async merge(
    input: ProcessRunInput,
    thread: GoalThread,
    evidence: ThreadDecisionEvidence,
    // Not part of the persisted evidence shape (see the Phase 2 schema) but
    // still counted toward confidence — see isSameAgentContinuation.
    sameAgentContinuation = false,
  ): Promise<ThreadDecision> {
    const entities = extractEntities(input.run.prompt);
    await this.store.mutate((database) => {
      const stored = database.goalThreads.find((item) => item.id === thread.id);
      if (!stored) return;
      stored.runIds.push(input.run.id);
      const merged = new Set(stored.keyEntities.map((e) => e.toLowerCase()));
      for (const entity of entities) {
        if (!merged.has(entity.toLowerCase())) {
          stored.keyEntities.push(entity);
          merged.add(entity.toLowerCase());
        }
      }
      stored.updatedAt = now();
    });
    const agreeingSignals = countAgreeingSignals({
      workspaceOverlap: evidence.workspaceOverlap,
      explicitReference: evidence.explicitReference,
      shared: evidence.sharedEntities,
      sameAgentContinuation,
    });
    const confidence = agreeingSignals >= 2 ? 0.9 : 0.65;
    return this.persistDecision(input, {
      decision: "MERGE",
      confidence,
      targetThreadId: thread.id,
      evidence,
    });
  }

  private async createNew(
    input: ProcessRunInput,
    entities: string[],
    evidence: ThreadDecisionEvidence,
  ): Promise<ThreadDecision> {
    const timestamp = now();
    const thread: GoalThread = {
      id: randomUUID(),
      title: titleFromEntities(entities, input.run.prompt),
      status: "ACTIVE",
      summary: input.run.prompt.slice(0, 280),
      createdAt: timestamp,
      updatedAt: timestamp,
      runIds: [input.run.id],
      keyEntities: entities,
      parentThreadId: null,
      closedReason: null,
    };
    await this.store.mutate((database) => {
      database.goalThreads.push(thread);
    });
    return this.persistDecision(input, {
      decision: "NEW",
      confidence: 1,
      targetThreadId: thread.id,
      evidence,
    });
  }

  private async fork(
    input: ProcessRunInput,
    parent: GoalThread,
    // The new goal's entities only (not the full extraction, which may still
    // mention the old goal by name, e.g. "forget Tokyo") — otherwise the
    // forked thread would keep matching future Runs that mention the goal it
    // just abandoned.
    childEntities: string[],
    evidence: ThreadDecisionEvidence,
  ): Promise<ThreadDecision> {
    const timestamp = now();
    const child: GoalThread = {
      id: randomUUID(),
      title: titleFromEntities(childEntities, input.run.prompt),
      status: "ACTIVE",
      summary: input.run.prompt.slice(0, 280),
      createdAt: timestamp,
      updatedAt: timestamp,
      runIds: [input.run.id],
      keyEntities: childEntities,
      parentThreadId: parent.id,
      closedReason: null,
    };
    await this.store.mutate((database) => {
      const storedParent = database.goalThreads.find((item) => item.id === parent.id);
      if (storedParent) {
        storedParent.status = "CLOSED";
        storedParent.closedReason =
          "Forked into \"" + child.title + "\": " + evidence.semanticNote;
        storedParent.updatedAt = timestamp;
      }
      database.goalThreads.push(child);
    });
    return this.persistDecision(input, {
      decision: "FORK",
      confidence: 0.85,
      targetThreadId: child.id,
      evidence,
    });
  }

  private async persistDecision(
    input: ProcessRunInput,
    partial: {
      decision: ThreadDecision["decision"];
      confidence: number;
      targetThreadId: string | null;
      evidence: ThreadDecisionEvidence;
    },
  ): Promise<ThreadDecision> {
    const decision: ThreadDecision = {
      id: randomUUID(),
      runId: input.run.id,
      agentId: input.agent.id,
      decision: partial.decision,
      confidence: partial.confidence,
      targetThreadId: partial.targetThreadId ?? "",
      evidence: partial.evidence,
      createdAt: now(),
    };
    await this.store.mutate((database) => {
      database.threadDecisions.push(decision);
    });
    return decision;
  }
}
