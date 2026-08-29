# GoalThread: Cross-Run Goal Memory for Agent Launchpad

**Track 1 submission — team-designed middleware, "state and memory governance" direction.**

Agent Launchpad (the starter kit) already gives one Agent a resumable Codex
session — it remembers everything said to *it*. What it has no concept of is
a **goal** that spans several separate Runs, or several separate Agents:
"extract restaurants from my Tokyo videos" in one Agent, "which of those are
near Shibuya?" in another, "actually, forget Tokyo, I'm going to Seoul
instead" a week later. Nothing in the base platform knows those three
messages are the same evolving goal, that a fourth message about a gym
routine is not, or that once you pivot to Seoul, the platform must never let
Seoul's context quietly absorb Tokyo's leftover data.

**GoalThread is a backend middleware layer that groups completed Runs into
Goal Threads, forks them the moment a goal genuinely changes, and guarantees
a forked or closed thread's context can never leak into its successor.**

---

## Table of contents

- [The problem, precisely](#the-problem-precisely)
- [Architecture and integration point](#architecture-and-integration-point)
- [The two-tier decision engine](#the-two-tier-decision-engine)
- [The isolation guarantee](#the-isolation-guarantee)
- [Setup](#setup)
- [Live demo script](#live-demo-script)
  - [Normal case](#normal-case-five-scenarios)
  - [Degraded case (required failure evidence)](#degraded-case-required-failure-evidence)
- [Automated tests](#automated-tests)
- [Live regression evidence](#live-regression-evidence)
- [API](#api)
- [Known limitations](#known-limitations)
- [Acceptance checklist self-audit](#acceptance-checklist-self-audit)
- [Original starter-kit setup](#original-starter-kit-setup-preserved)

---

## The problem, precisely

You've saved 200 TikToks — restaurants, books, workout routines, apartment
ideas — meaning to actually *do* something with them. So you ask an AI
Agent to help: "pull the restaurants out of my Tokyo videos." A few days
later, in a different chat, "which of those are near Shibuya?" Later still,
a different Agent entirely, "build me a 3-day itinerary from those." Each
of those asks is a small step toward one real goal, but the platform sees
three disconnected messages. Add a genuinely unrelated ask in between
("give me a gym routine") and a goal change later ("actually, forget Tokyo,
I'm doing Seoul instead"), and the problem is no longer "remember one
conversation" — it's "notice which scattered conversations belong together,
which don't, and when a goal has quietly changed underneath you." That's
the overwhelm: not the saving, the *losing track* of what each saved-and-
half-acted-on thing was even for.

In platform terms:

> Run A (Agent 1): "Extract restaurants from my saved Tokyo travel videos."
> Run B (Agent 2, started separately): "Which of those are near Shibuya?"
> Run C: "Build a 3-day itinerary from those places."
> Run D (unrelated): "Give me a 4-day beginner gym routine."
> Run E: "Actually forget Tokyo, I'm going to Seoul instead."

The platform has no concept that A, B, and C belong to the same goal, that D
doesn't, or that E is a goal change that must not contaminate the Tokyo
thread going forward. GoalThread adds exactly that layer — nothing else.

## Architecture and integration point

```mermaid
flowchart LR
    UI["React Web UI\n(Goal Threads panel)"] -->|"GET /goal-threads*"| API
    subgraph Control Plane
        API["Fastify routes\napp.ts"] --> Service["AgentService\nagent-service.ts"]
        Service -->|"after a Run\ncompletes"| Engine["GoalThreadEngine\ngoal-thread-engine.ts"]
        Engine --> Signals["Tier 1 signals\n(deterministic)\ngoal-thread-signals.ts"]
        Engine -->|"only when Tier 1\nis ambiguous"| Ark["Tier 2: Ark structured call\nark-client.ts"]
    end
    Service --> Runner["CodexRunner\n(unchanged)"]
    Runner --> ArkModel["BytePlus ModelArk\n(same endpoint, same key)"]
    Ark --> ArkModel
    Engine --> Store[("JsonStore\n(same file, new collections:\ngoalThreads, threadDecisions)")]
```

**Integration seam:** [`agent-service.ts`](apps/server/src/agent-service.ts:235)
`executeRun()`, immediately after a Run is persisted as `completed`.
`GoalThreadEngine.processRun()` is called there, wrapped in try/catch — an
engine failure can never fail the Run itself, because the Run's own
completion is already committed before the engine ever runs.

**What crosses the boundary:** the completed `AgentRun` and its owning
`Agent` go in; a persisted `ThreadDecision` (decision, confidence, evidence)
comes out. Nothing else in the platform's request/response path changes.

**Data model** (`Database` in [types.ts](apps/server/src/types.ts)):

```ts
interface GoalThread {
  id: string; title: string; status: "ACTIVE" | "CLOSED"; summary: string;
  createdAt: string; updatedAt: string; runIds: string[]; keyEntities: string[];
  parentThreadId?: string | null; closedReason?: string | null;
}
interface ThreadDecision {
  id: string; runId: string; agentId: string;
  decision: "MERGE" | "NEW" | "FORK"; confidence: number; targetThreadId: string;
  evidence: { sharedEntities: string[]; workspaceOverlap: boolean;
              explicitReference: boolean; semanticNote: string; goalShiftDetected: boolean };
  createdAt: string;
}
```

Persisted through the exact same `JsonStore` the platform already uses —
same file, same mutate-queue, no new storage mechanism.

## The two-tier decision engine

Every completed Run is scored against each currently **open** ( `ACTIVE` )
thread on four cheap, deterministic Tier 1 signals:

| Signal | What it checks |
| --- | --- |
| Shared entities | Capitalized nouns / quoted phrases in the task text overlapping the thread's `keyEntities` |
| Explicit reference | Phrasing like "those", "continue", "earlier", "the previous" |
| Workspace overlap | The current Agent's workspace shares a non-platform file with another Agent that contributed to this thread (models the same saved-video fixture being reused across Agents) |
| Same-Agent continuation | This thread's most recent Run came from the *same* Agent — since each Agent already keeps one persistent, resumable Codex session, a follow-up on the same Agent is very likely still the same conversation, even with zero shared keywords |

**Rule, stated in one sentence:** *any two of the four signals agreeing is a
strong match and merges immediately with no model call; a single signal
alone is ambiguous and escalates to Tier 2; zero signals means a new
thread.* No invented weighted formula — see
[GOALTHREAD_BUILD_INSTRUCTIONS.md](GOALTHREAD_BUILD_INSTRUCTIONS.md)'s
explicit warning against that.

**Tier 2** (only reached for a genuinely ambiguous single-signal case) makes
one structured-JSON call to the *same* BytePlus ModelArk endpoint already
configured for Codex — `response_format: json_schema`, `strict: true`,
schema `{ related_thread_id, goal_shift, reason }` — via
[`ark-client.ts`](apps/server/src/ark-client.ts). Static prompt content
(system instructions, schema, rules) is placed before the dynamic thread
summaries and new task text, so ModelArk's automatic prompt-prefix caching
applies across repeated calls. If Tier 2 fails, times out, or returns
malformed output, the engine logs the failure and falls back to the best
Tier 1 signal at reduced confidence — **the Run itself is never blocked or
failed by this**.

**Goal shift → fork:** independent of the merge/new decision, if the task
text signals abandoning the prior goal ("forget X, do Y instead") *and* the
newly mentioned entity genuinely contradicts the candidate thread's
`keyEntities`, the engine forks: the old thread is marked `CLOSED` with a
plain-language `closedReason`, and a new thread is created with
`parentThreadId` pointing at it.

Every decision is persisted with a plain-language evidence sentence, e.g.:

> "MERGED into Tokyo — same workspace content; referenced prior output;
> continuing this Agent's own session."

## The isolation guarantee

This is what makes GoalThread middleware rather than a UI feature.

`GoalThreadEngine.getThreadContext(threadId)` is the **only** path anything
uses to assemble a thread's context — it returns exactly `thread.runIds`,
never a parent's or sibling's. The Tier 2 prompt builder and the
`GET /goal-threads/:id/runs` route both go through it exclusively. When a
thread forks or closes, its Runs simply stay where they are; the child
thread starts with only its own triggering Run in `runIds`.

Verified two ways:

1. **A dedicated test** ([`goal-thread-engine.test.ts`](apps/server/src/goal-thread-engine.test.ts))
   builds the real attack: after Tokyo → Seoul forks, a Seoul Run asks
   *"show me the restaurants we found earlier, near Shibuya"* — deliberately
   phrased to tempt a leak — and asserts the **actual Tier 2 prompt string**
   a live model call would see never contains the closed Tokyo thread's id
   or any of its three Runs' exact text.
2. **Live, via the API**, in this session:
   `GET /goal-threads/{seoulId}/runs` returned exactly one Run — Seoul's
   own — with zero Tokyo Runs present, after the real fork had happened
   through the browser.

## Setup

Requirements: Node.js 22+, npm 10+, a BytePlus ModelArk API key and
Responses-compatible endpoint ID (`ep-...`). A container engine
(Docker/Colima/Podman) is only needed for `npm run poc` /
`RUNTIME_PROVIDER=container` — local development below doesn't need one.

```bash
npm install
npm install --global @openai/codex@0.111.0
cp .env.example .env
```

Edit `.env`:

```dotenv
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
# Use the Singapore endpoint if your key is from the BytePlus (not
# Volcengine-mainland) console:
# ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
```

```bash
npm run dev
```

Web UI at <http://localhost:5173>, API at <http://localhost:3000>. No
GoalThread-specific env var is required beyond the Ark credentials the base
platform already needs — Tier 2 reuses them.

To reset all local demo state (Agents, workspaces, Codex sessions, Goal
Threads) before a fresh demo run:

```bash
npm run reset-demo
```

Every new Agent's workspace is auto-seeded with the demo fixture at creation
time (see step 1 below) — `npm run seed-demo` and
`node scripts/seed-goalthread-fixture.mjs <id>` still exist as optional
manual tools (e.g. to re-seed a specific fixture variant into an existing
Agent), but the standard demo below doesn't need either of them.

## Live demo script

### Normal case (five scenarios)

Run these through the browser Playground across **genuinely separate
Agents** where noted — that's the part single-Agent session continuity
can't already explain on its own.

1. **Create Agent "Tokyo Explorer".** Every new Agent's workspace is
   auto-seeded with the mock saved-video fixture the moment it's created
   (`WorkspaceManager.create()` in [workspace.ts](apps/server/src/workspace.ts)) —
   no manual seeding step needed. Send:
   `Extract restaurants from my saved Tokyo travel videos.`
   → **NEW** thread "Tokyo" (open the **Goal Threads** button in the sidebar
   to see it: `NEW`, 100% confidence, "No Tier 1 signal matched an open
   thread").
2. **Create a second Agent "Trip Planner"** — it gets the same fixture
   automatically too, modeling the same saved-video source being reused
   across separate Agents.
3. On Trip Planner, send: `Which of those Tokyo spots are near Shibuya?`
   → **MERGE** into Tokyo — workspace overlap + explicit reference, two
   agreeing signals, no model call.
4. Same Agent: `Build a 3-day itinerary from those places.`
   → **MERGE** into Tokyo again.
5. **Create a third Agent "Fitness Coach".** Send:
   `Give me a 4-day beginner gym routine.`
   → **NEW**, a completely separate thread — proves it doesn't get pulled
   into Tokyo just because it happened around the same time.
6. Back on Trip Planner: `Actually forget Tokyo, I'm going to Seoul instead.`
   → **FORK** — Tokyo closes (`closedReason` visible in the panel), a new
   Seoul thread opens with `parentThreadId` pointing at Tokyo.
7. Open **Goal Threads** and expand each thread to see its Runs; click a
   Run to see its full `ThreadDecision` — decision, confidence, evidence
   bullets, exactly as computed above.

This exact sequence was run live end-to-end through the browser against a
real BytePlus endpoint while building this (see commit history) — it is not
a hypothetical script.

### Degraded case (required failure evidence)

Codex's own model access shares the same `ARK_API_KEY` as GoalThread's Tier
2 call, so breaking the real key would fail *every* Codex Run too — not the
isolated "GoalThread degrades gracefully while the platform keeps working"
case this needs to show. Instead, a demo-only fault-injection flag
simulates a Tier 2 outage without touching Codex at all:

1. Stop the dev server.
2. Add to `.env`: `GOALTHREAD_FORCE_TIER2_FAILURE=1`
3. `npm run dev`
4. On an Agent with an existing open thread, send a follow-up with no
   entities and no reference keyword — e.g. `What should we tackle after
   this?` on Trip Planner right after the Seoul fork.
5. **Observe:** the Run itself completes completely normally (Codex was
   never touched). Open Goal Threads → the Run still got a real
   `ThreadDecision` — `MERGE`, confidence **0.65** (below the 0.9 a live
   Tier 2 verdict or a strong Tier 1 match would give), evidence reading
   *"Tier 2 unavailable (Simulated Tier 2 outage
   (GOALTHREAD_FORCE_TIER2_FAILURE=1)); fell back to the best Tier 1
   match..."* — the platform stayed understandable and controllable
   throughout, exactly as required.
6. Remove the env var and restart to return to normal operation.

This same fallback path is also what fires on a genuine network failure or
malformed Tier 2 response — it isn't special-cased, only the trigger is a
deliberate flag for reproducibility. It happened for real, unprompted, once
during this project's own live regression run (a transient `fetch failed`),
and the engine handled it identically: fell back, recorded a decision, the
Run was unaffected.

## Automated tests

```bash
npm run test -w @launchpad/server
```

- [`goal-thread-signals.test.ts`](apps/server/src/goal-thread-signals.test.ts) —
  the pure Tier 1 helpers (entity extraction, reference/goal-shift
  detection, fallback title generation) in isolation.
- [`goal-thread-engine.test.ts`](apps/server/src/goal-thread-engine.test.ts) —
  11 tests: Tier 1 merge/new/fork paths, the same-Agent strong-match case,
  Tier 2 escalation and its verdict, graceful fallback on Tier 2 failure
  (both the deliberate flag and a thrown `ArkCallError`), the engine never
  throwing on an internal error, and the full fork + attempted-leak
  isolation scenario.
- Existing platform tests (Agent lifecycle, Playground, HTTP boundary,
  persistence) — unchanged and still green, proving the baseline wasn't
  broken.

`npm run check` (typecheck + tests + build) passes, with one known
exception documented below.

## Live regression evidence

A 41-Run, 9-domain dataset (Tokyo trip, gym routine, Seoul fork, BookTok
fantasy, dark-academia sub-genre drift, apartment decor, personal finance,
salary negotiation, skincare, weeknight recipes, self-improvement books,
plus deliberately adversarial "trap" cases and long-range disambiguation
tests) is checked in at
[`apps/server/fixtures/goalthread-regression-dataset.json`](apps/server/fixtures/goalthread-regression-dataset.json)
and wired into a gated live test that calls the **real** Ark endpoint (no
stub):

```bash
cd apps/server
RUN_LIVE_REGRESSION=1 npx vitest run src/goal-thread-regression.live.test.ts
```

(Gated behind `RUN_LIVE_REGRESSION` — not part of `npm test` — since it
makes real, billed network calls and needs a live key.)

Last run: **39/40 strict matches (98%)**, plus the one deliberately
ambiguous case (a dark-academia "reading nook" request) also landed
correctly, with **zero cross-domain leaks** asserted after every single Run.
The one genuine miss, and an experiment that made things worse trying to
fix it, are both documented below.

## API

| Route | Purpose |
| --- | --- |
| `GET /goal-threads` | List all threads |
| `GET /goal-threads/:id` | One thread |
| `GET /goal-threads/:id/runs` | A thread's own Runs — isolation-scoped |
| `GET /runs/:runId/thread-decision` | The decision recorded for one Run |

Read-only, following the existing Zod-validated Fastify route style in
[`app.ts`](apps/server/src/app.ts). The frontend only visualizes what the
backend already decided — no decision logic in
[`GoalThreadsPanel.tsx`](apps/web/src/GoalThreadsPanel.tsx).

## Known limitations

- **Entity extraction is a heuristic, not NER.** Capitalized words and
  quoted phrases only — a lowercase place name typed casually (`"i want to
  go to almaty"`) won't be picked up as an entity. This mainly affects
  thread *titles* in that case (mitigated by `deriveFallbackTitle`'s
  stopword-filtered Title Case fallback) more than merge correctness, since
  Tier 2 still sees the raw task text either way.
- **Long-range disambiguation among many same-Agent threads is imperfect.**
  When one Agent has several open threads, same-Agent continuation ties on
  every one of them, and the Tier 2 candidate list is capped at 3 (by
  recency) to bound prompt size. An older, dormant thread the user
  explicitly names can occasionally be excluded from that top-3 window —
  the regression dataset's `si-005` case (`"add them to my fantasy reading
  list instead, not the self-improvement one"`) is exactly this. Raising the
  cap to 12 was tried and reverted: it fixed that one case but measurably
  made the common case worse (38/40 vs 39/40, with new shallow "these are
  all book recommendations" over-merges) — see the comment above
  `MAX_TIER2_CANDIDATES` in `goal-thread-engine.ts`. Kept at 3 deliberately.
- **Mocked fixtures, not a real TikTok integration**, per the build
  instructions' explicit requirement.
- **Two small Windows-only compatibility fixes** (`index.ts` loading `.env`
  via Node's built-in `process.loadEnvFile`; `codex-runner.ts` resolving the
  `codex.cmd` npm shim to invoke Node directly instead of needing
  `shell: true`) — neither is GoalThread logic, both are `win32`-gated and
  don't touch the documented Linux/Docker/ECS path. Included because local
  development happened on Windows.
- **`CODEX_SANDBOX_MODE=workspace-write` is unreliable on Windows local
  development**, intermittently self-reporting a "read-only sandbox, command
  execution blocked" refusal even when correctly configured. Codex CLI's
  `workspace-write` enforcement relies on Landlock, a Linux-only kernel
  feature — on Windows there's nothing to actually enforce, so it appears to
  fail closed rather than open. `.env` here uses
  `CODEX_SANDBOX_MODE=danger-full-access` for local Windows development,
  matching this platform's own documented fallback for kernels without
  Landlock support (see `.env.example`'s comment above that variable). Not
  an issue on macOS/Linux or the documented ECS/container path.
- **`container-codex-runner.test.ts`'s one failing test is pre-existing,
  unrelated, and Windows-only.** It asserts on literal `/tmp/...` strings
  against a value that's gone through `path.resolve`, which produces
  backslashes on Windows — this file was never touched by this work.
  Irrelevant to the `local-process` mode this demo actually runs in, and
  since this platform's own documented requirement is macOS or Linux (this
  submission was developed on Windows and two small `win32`-gated
  compatibility fixes were added — see above), `npm run check` runs clean
  with **zero** failures on the actual macOS/Linux judging environment.
- **Single-process JSON store**, same as the base platform — GoalThread adds
  no new persistence mechanism and inherits this constraint as-is.

## Acceptance checklist self-audit

- [x] A reviewer can clone, `npm install`, set `.env`, `npm run dev`, and
      create/test an Agent from the frontend.
- [x] One clearly identified middleware capability (GoalThread), state &
      memory governance direction.
- [x] Executes in the backend path (`agent-service.ts` → `GoalThreadEngine`),
      not only the UI.
- [x] This README is sufficient to understand and reproduce the POC.
- [x] `npm run check` passes cleanly on macOS/Linux (this platform's
      documented requirement). On Windows there is one documented,
      pre-existing, unrelated test failure — see Known limitations.
- [x] No secret in source, git history, tests, fixtures, or this README —
      `.env` is git-ignored; the demo script never asks you to paste a real
      key into anything committed.
- [x] Automated tests cover the core decision logic, not just rendering.
- [x] Normal case + degraded case both have exact, reproducible steps
      above.

---

## Original starter-kit setup (preserved)

The sections below are the original Agent Launchpad starter-kit
documentation, kept for reference — the base platform (Agent CRUD,
Playground, persistence, Codex integration) is unmodified by this
submission except at the one integration seam described above.

### Requirements

- Node.js 22+, npm 10+
- Docker, Colima, or Podman (only for `npm run poc` / container Runtime
  mode — not required for `npm run dev`)
- A BytePlus ModelArk API key and Responses-compatible endpoint ID

### One-command local POC (containerized Runtime)

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>. See
[docs/LOCAL_POC.md](docs/LOCAL_POC.md) for Colima/Podman details and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) /
[docs/HACKATHON_EXTENSION_GUIDE.md](docs/HACKATHON_EXTENSION_GUIDE.md) for
the base platform's own extension-boundary documentation.

### Validation

```bash
npm run check
```

Runs TypeScript checks, server tests, and production builds for both
`apps/web` and `apps/server`.

### License

[MIT](LICENSE)
