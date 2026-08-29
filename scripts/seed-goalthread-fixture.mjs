#!/usr/bin/env node
/**
 * Drops a GoalThread demo fixture into an Agent's workspace, so the
 * workspace/file overlap Tier 1 signal has something real to detect —
 * simulating the same saved-video source material being reused across two
 * separate Agents. Mock data only; never integrates a real TikTok API.
 *
 * Usage:
 *   node scripts/seed-goalthread-fixture.mjs <agentId> [fixtureName]
 *
 * fixtureName defaults to tokyo-videos.json. Reads AGENT_WORKSPACE_ROOT from
 * the environment (falling back to apps/server/workspaces — npm workspace
 * scripts run with the package directory as cwd, so that's where
 * AGENT_WORKSPACE_ROOT=workspaces from .env actually resolves under
 * `npm run dev`) to find the target workspace.
 */
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , agentId, fixtureName = "tokyo-videos.json"] = process.argv;

if (!agentId) {
  console.error("Usage: node scripts/seed-goalthread-fixture.mjs <agentId> [fixtureName]");
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT
  ? path.resolve(process.env.AGENT_WORKSPACE_ROOT)
  : path.join(repoRoot, "apps", "server", "workspaces");

const source = path.join(repoRoot, "apps", "server", "fixtures", fixtureName);
const destination = path.join(workspaceRoot, agentId, fixtureName);

try {
  await copyFile(source, destination);
  console.log("Copied " + fixtureName + " into " + destination);
} catch (error) {
  console.error("Failed to seed fixture: " + (error instanceof Error ? error.message : String(error)));
  console.error("Check that the Agent id is correct and the Agent has already been created.");
  process.exit(1);
}
