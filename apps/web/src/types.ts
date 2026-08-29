export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export type ThreadStatus = "ACTIVE" | "CLOSED";
export type ThreadDecisionKind = "MERGE" | "NEW" | "FORK";

export interface GoalThread {
  id: string;
  title: string;
  status: ThreadStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  keyEntities: string[];
  parentThreadId?: string | null;
  closedReason?: string | null;
}

export interface ThreadDecisionEvidence {
  sharedEntities: string[];
  workspaceOverlap: boolean;
  explicitReference: boolean;
  semanticNote: string;
  goalShiftDetected: boolean;
}

export interface ThreadDecision {
  id: string;
  runId: string;
  agentId: string;
  decision: ThreadDecisionKind;
  confidence: number;
  targetThreadId: string;
  evidence: ThreadDecisionEvidence;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
