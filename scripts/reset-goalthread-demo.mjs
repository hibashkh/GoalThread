#!/usr/bin/env node
/**
 * Wipes local demo state (Agents, workspaces, Codex sessions, Goal Threads)
 * for a clean start before a demo or a fresh test pass. Cross-platform
 * (plain Node fs, no shell-specific `rm`) so it works the same in
 * PowerShell, cmd, and POSIX shells.
 *
 * Targets the apps/server/{.data,workspaces,codex-home} paths that
 * `npm run dev` actually uses (npm workspace scripts run with the package
 * directory as cwd, so AGENT_WORKSPACE_ROOT=workspaces from .env resolves
 * there, not at the repo root).
 *
 * Usage: node scripts/reset-goalthread-demo.mjs
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverDir = path.join(repoRoot, "apps", "server");
const targets = [".data", "workspaces", "codex-home"].map((name) =>
  path.join(serverDir, name),
);

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  console.log("Removed " + target);
}
console.log("\nDemo state reset. Run `npm run dev` to start fresh.");
