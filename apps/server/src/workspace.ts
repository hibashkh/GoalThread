import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./types.js";

// GoalThread demo fixture: mock saved-video captions (not a real TikTok
// integration — see fixtures/goalthread-regression-dataset.json's own
// description, and the README's problem statement). Auto-copied into every
// new Agent's workspace so the demo needs no manual seeding step — it
// models every Agent having access to the same synced saved-video library
// from the moment it's created, which is both more realistic than a manual
// per-Agent copy step and removes an artificial-looking setup step from the
// live demo. Missing the fixture (e.g. a stripped-down checkout) is
// non-fatal — Agent creation must never fail because of a demo convenience.
const DEMO_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/tokyo-videos.json", import.meta.url),
);
const DEMO_FIXTURE_NAME = "tokyo-videos.json";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      await copyFile(
        DEMO_FIXTURE_PATH,
        path.join(agent.workspacePath, DEMO_FIXTURE_NAME),
      );
    } catch {
      // Non-fatal — see DEMO_FIXTURE_PATH's comment above.
    }
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
