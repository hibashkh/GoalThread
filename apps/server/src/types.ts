export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
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

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  goalThreads: GoalThread[];
  threadDecisions: ThreadDecision[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
