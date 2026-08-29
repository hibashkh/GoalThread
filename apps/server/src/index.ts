import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { GoalThreadEngine } from "./goal-thread-engine.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

// `npm run dev` runs this workspace script with its cwd set to apps/server,
// not the repo root, so load the root .env explicitly. Docker/Compose/ECS
// already have real environment variables set and don't ship a .env file —
// that's expected and fine here.
try {
  process.loadEnvFile(
    path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../.env"),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const goalThreads = new GoalThreadEngine(config, store);
const service = new AgentService(config, store, workspaces, runner, goalThreads);
await service.initialize();

const app = await createApp(config, service, goalThreads);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
