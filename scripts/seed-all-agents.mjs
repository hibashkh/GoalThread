#!/usr/bin/env node
/**
 * Seeds the GoalThread demo fixture into every existing Agent's workspace —
 * no agent id needed. Asks the running server for the current Agent list,
 * then copies the fixture into each one that doesn't already have it.
 *
 * Usage: node scripts/seed-all-agents.mjs [fixtureName] [--server=http://localhost:3000]
 */
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const serverArg = args.find((a) => a.startsWith("--server="));
const serverUrl = serverArg ? serverArg.slice("--server=".length) : "http://localhost:3000";
const fixtureName = args.find((a) => !a.startsWith("--")) ?? "tokyo-videos.json";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(repoRoot, "apps", "server", "fixtures", fixtureName);

if (!existsSync(source)) {
  console.error("Fixture not found: " + source);
  process.exit(1);
}

let agents;
try {
  const response = await fetch(serverUrl + "/api/agents");
  if (!response.ok) throw new Error("HTTP " + response.status);
  ({ agents } = await response.json());
} catch (error) {
  console.error(
    "Could not reach " +
      serverUrl +
      "/api/agents — is `npm run dev` running? (" +
      (error instanceof Error ? error.message : String(error)) +
      ")",
  );
  process.exit(1);
}

if (!agents || agents.length === 0) {
  console.log("No Agents exist yet — create some first, then rerun this.");
  process.exit(0);
}

for (const agent of agents) {
  const destination = path.join(
    repoRoot,
    "apps",
    "server",
    "workspaces",
    agent.id,
    fixtureName,
  );
  try {
    await copyFile(source, destination);
    console.log("Seeded " + agent.name + " (" + agent.id + ")");
  } catch (error) {
    console.error(
      "Failed to seed " +
        agent.name +
        " (" +
        agent.id +
        "): " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

console.log("\nDone — " + agents.length + " Agent(s) checked.");
