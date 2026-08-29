# GoalThread Middleware — Build Instructions

## Context

You're working inside the Agent Launchpad starter kit — an existing platform with a React frontend, Fastify backend, AgentService, persistent per-Agent workspaces, Codex CLI runtime, async Runs, and JSON persistence. This is a hackathon submission. Your job is to add **one middleware capability** without breaking anything already working.

## What already works — do not rebuild this

- Agent CRUD, start/stop/delete
- Playground multi-turn chat, async Run polling
- Persistent per-Agent workspace, resumable Codex session
- JSON-backed persistence for Agent/Run/message metadata

Preserve all of it. Extend, don't replace.

## Provider notes — BytePlus ModelArk (ap-southeast-1)

Confirmed directly from BytePlus's own docs and code samples:

- **Regional base URL matters.** A key generated from the `ap-southeast-1` console (Singapore) is tied to the ap-southeast-1 endpoint: `https://ark.ap-southeast.bytepluses.com/api/v3`. If the starter kit's default config points anywhere else, override it explicitly — otherwise you'll get auth or routing errors that look like a bad key when the key is actually fine.
- **Auth is a standard bearer header**: `Authorization: Bearer <ARK_API_KEY>`. This should already be handled automatically if the starter kit's client follows the OpenAI-Responses-compatible pattern it claims to.
- **`ARK_MODEL` must be an endpoint ID, not a model name** — it should start with `ep-`. This is the single most common cause of a 401 per BytePlus's own docs: people either use a BytePlus account AK/SK instead of an Ark API key, or pass a raw model name instead of the endpoint ID.
- **Rate limits are per model** (requests/minute and tokens/minute). Treat a 429 from the Tier 2 model call in Phase 3 exactly like a provider outage — fall back to Tier 1 signals, don't retry-loop and don't block the Run.
- **Do not use ModelArk "Managed Agents"** (the `/agents`, `/environments`, `/sessions` API family with its own AgentLoop and sandbox) for anything in this build. It's a full alternative agent runtime — it hosts its own sandbox, tool execution, and session/event persistence, which would mean replacing the starter kit's Agent Runtime layer rather than adding middleware to it. That's explicitly out of scope for this challenge. Stick to the plain Responses/Chat API for both the platform's existing model calls and GoalThread's Tier 2 classification.

## The problem you're solving

Users pursue real-world goals across many fragmented Agent Runs — sometimes across multiple Agents, not just multiple turns in one session. Example:

- Run A (Agent 1): "Extract restaurants from my saved Tokyo travel videos."
- Run B (Agent 2, started separately): "Which of those are near Shibuya?"
- Run C: "Build a 3-day itinerary from those places."
- Run D (unrelated): "Give me a 4-day beginner gym routine."
- Run E: "Actually forget Tokyo, I'm going to Seoul instead."

The platform currently has no concept that A, B, and C belong to the same goal, that D doesn't, and that E represents a goal change that should not contaminate the Tokyo thread. GoalThread Middleware adds that layer.

---

## Phase 1 — Inspect before building

Before writing anything:

1. Map the repo: backend entry point, Fastify routes, AgentService, Run creation/completion lifecycle, Run/Message/Agent types, the JSON persistence layer, workspace file structure, and frontend structure. Start from `apps/server/src/types.ts`, `apps/server/src/app.ts`, `apps/server/src/agent-service.ts`, the `AgentRunner` implementations, and `apps/web/src/App.tsx`.
2. Identify the smallest, cleanest seam to hook into — most likely the point where a Run is created and the point where a Run completes.
3. Explain the integration plan back before touching code.

## Phase 2 — Data model

Add two persisted entities, following the existing persistence conventions already used in this repo:

**GoalThread**
- `id`, `title`, `status` (`ACTIVE` | `CLOSED`), `summary`
- `createdAt`, `updatedAt`
- `runIds: string[]`
- `keyEntities: string[]`
- `parentThreadId?: string` (set when forked from another thread)
- `closedReason?: string`

**ThreadDecision** (one per Run — a permanent audit record)
- `id`, `runId`, `agentId`
- `decision`: `MERGE` | `NEW` | `FORK`
- `confidence: number` (0–1)
- `targetThreadId`
- `evidence`: `{ sharedEntities: string[], workspaceOverlap: boolean, explicitReference: boolean, semanticNote: string, goalShiftDetected: boolean }`
- `createdAt`

Adapt field names/shape to match whatever the repo's existing Run/Agent types look like — consistency with the existing codebase matters more than matching this schema exactly.

## Phase 3 — Decision engine

Implement a `GoalThreadEngine` that runs once per completed Run, using two tiers:

**Tier 1 — deterministic signals** (cheap, explainable, always computed):
- Workspace/file overlap — does this Run touch the same Agent workspace or files as Runs in an existing thread?
- Shared entities — extract key nouns (places, projects, named subjects) from the Run's task text and compare against each open thread's `keyEntities`.
- Explicit reference — does the task text reference prior output ("those", "that list", "the previous", "continue", "based on what we found")?

**Tier 2 — model-assisted judgment** (only invoked when Tier 1 is ambiguous):
- One structured call to the model provider already configured in this repo — reuse it, don't add a new provider or API key.
- Use ModelArk's native structured output mode rather than hoping the model formats its own JSON correctly. Set `response_format` to `json_schema` (not `json_object` — `json_schema` is the recommended, schema-conformant mode) with `strict: true`, and define the schema for exactly `{ related_thread_id: string | null, goal_shift: boolean, reason: string }`. Mark all three fields `required` and set `additionalProperties: false` on the schema — this makes the model output that exact shape rather than something close to it. Don't combine this with `frequency_penalty` or `presence_penalty`; ModelArk's docs flag that combination as causing abnormal output.
- If the starter kit's existing client doesn't expose `response_format` directly, fall back to asking for strict JSON in the prompt text and parse defensively.
- Minor cost/latency tip: put the static parts of the Tier 2 prompt (system instructions, the JSON schema, the decision rules) before the dynamic parts (thread summaries, the new task text). ModelArk automatically caches repeated prompt prefixes at no storage cost, so structuring it this way makes repeated Tier 2 calls cheaper and faster for free — not required, but easy to get right from the start.
- If the call fails, returns malformed output, hits a rate limit, or the provider is unreachable, fall back to Tier 1 signals alone and log the fallback. The engine must never crash or block a Run because of this.

**Decision logic:**
- No Tier 1 signal matches any existing thread → `NEW`
- Strong Tier 1 match (e.g. workspace overlap + shared entity, or explicit reference + shared entity) → `MERGE`, high confidence, no model call needed
- Weak/mixed Tier 1 signals → call Tier 2, use its verdict
- Task text signals a goal change relative to the thread it would otherwise merge into ("forget X, instead Y", contradicting entities) → `FORK`: close or mark the old thread, create a new thread with `parentThreadId` pointing at it

Do not invent a precise weighted formula for combining signals (e.g. "0.45 × semantic + 0.20 × entity") — it isn't backed by real calibration and won't hold up under questioning. Use clear rule-based logic you can state and defend in one sentence.

Every decision must be persisted with plain-language evidence, e.g.:
> "MERGED into Tokyo Trip — shared entities: Tokyo, Shibuya; same workspace; referenced 'those restaurants'."

## Phase 4 — Context isolation guarantee

This is what makes this middleware rather than a UI feature. Do not skip it.

When a thread is forked or closed, prove the new thread's context assembly cannot pull in the old thread's data:
- When building context/memory for a Run in a new or forked thread, scope it strictly to `runIds` belonging to that thread — never assemble context from a parent or sibling thread's Runs.
- Write a test that deliberately tries to leak context across the boundary (e.g. a Run in the Seoul thread references "the restaurants we found earlier" from the closed Tokyo thread) and confirms the engine does not silently pull Tokyo data into Seoul's context.

## Phase 5 — API

Add minimal endpoints following the existing Fastify route/validation conventions in this repo:
- `GET /goal-threads`
- `GET /goal-threads/:id`
- `GET /goal-threads/:id/runs`
- `GET /runs/:runId/thread-decision`

## Phase 6 — Minimal UI

Add the smallest possible addition to the existing frontend:
- A Goal Threads panel/list: thread title, status, run count, list of run summaries.
- On selecting a Run (or thread), show its `ThreadDecision`: decision, confidence, evidence bullets.

The UI only visualizes what the backend already decided — no decision logic in the frontend.

## Phase 7 — Demo scenarios (must work end to end from the browser)

Run these across genuinely separate Agents/Runs where possible — the platform already handles session continuity within one Agent, so the demo needs to show something beyond that:

1. New Agent, Run: "Extract restaurants from my saved Tokyo travel videos." → **NEW THREAD** (Tokyo Trip)
2. Second Run (different Agent, overlapping workspace or referencing prior output): "Which of those are near Shibuya?" → **MERGE** into Tokyo Trip
3. Third Run: "Build a 3-day itinerary from those places." → **MERGE** into Tokyo Trip
4. Unrelated Run: "Give me a 4-day beginner gym routine." → **NEW THREAD** (Gym), proven separate from Tokyo Trip
5. Goal-shift Run: "Actually forget Tokyo, I'm going to Seoul instead." → **FORK**: Tokyo Trip closed/parent, Seoul Trip created — and the Phase 4 isolation test shows no Tokyo data leaking into Seoul.

Provide mock saved-video content as plain text/JSON fixtures dropped into the Agent workspace. Do not integrate a real TikTok API.

## Phase 8 — Testing

Automated tests covering:
- Related Runs merge correctly (Tier 1 path)
- Ambiguous Runs correctly invoke Tier 2 and merge/don't merge based on its verdict
- Clearly unrelated Runs stay separate
- Goal shift triggers `FORK`, not a silent merge
- Context isolation: no cross-thread leakage after fork/close (the most important test — do not skip)
- Model/provider failure falls back to Tier 1 gracefully without crashing the Run
- Existing Agent lifecycle, Playground, and persistence behavior is unchanged

## Engineering rules

- Inspect before changing code; make the smallest viable change at each step.
- Reuse the existing model provider configuration — no new API key or provider.
- Reuse the existing persistence pattern rather than introducing new storage.
- Match the existing language/style conventions (TypeScript if the repo is TypeScript).
- No secrets in source; any new env var goes in `.env.example`.
- Fail safe: if any part of the engine errors, the Run itself must still complete normally.

## Deliverable summary — report back when done

1. Architecture summary and exact integration point(s)
2. Every file created/modified
3. How the two-tier decision logic works, in plain language
4. How the isolation guarantee is enforced and tested
5. Required env vars (should be none beyond what's already required, unless justified)
6. Commands to run the project and the test suite
7. Step-by-step demo script for the five Phase 7 scenarios
8. Known limitations / mocked pieces

Start by inspecting the repository and reporting the architecture and integration plan back before writing code.
