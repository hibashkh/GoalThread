import { useEffect, useState } from "react";
import { api } from "./api";
import type { AgentRun, GoalThread, ThreadDecision } from "./types";

/**
 * Pure display of what the backend already decided — no decision logic
 * lives here. Lists Goal Threads, and lets the user drill into a thread's
 * Runs and each Run's recorded ThreadDecision (decision, confidence,
 * evidence).
 */
export default function GoalThreadsPanel({ onClose }: { onClose: () => void }) {
  const [threads, setThreads] = useState<GoalThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [runsByThread, setRunsByThread] = useState<Record<string, AgentRun[]>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [decision, setDecision] = useState<ThreadDecision | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .goalThreads()
      .then((result) => {
        if (!cancelled) setThreads(result.goalThreads);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleThread = async (thread: GoalThread) => {
    setSelectedRunId(null);
    setDecision(null);
    if (expandedThreadId === thread.id) {
      setExpandedThreadId(null);
      return;
    }
    setExpandedThreadId(thread.id);
    if (!runsByThread[thread.id]) {
      try {
        const result = await api.goalThreadRuns(thread.id);
        setRunsByThread((current) => ({ ...current, [thread.id]: result.runs }));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  };

  const selectRun = async (runId: string) => {
    setSelectedRunId(runId);
    setDecision(null);
    setDecisionLoading(true);
    try {
      const result = await api.runThreadDecision(runId);
      setDecision(result.threadDecision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDecisionLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal goal-threads-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">GoalThread middleware</span>
            <h2>Goal Threads</h2>
            <p>What the backend decided about how Runs relate to each other.</p>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {threads === null ? (
          <p className="goal-thread-empty">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="goal-thread-empty">
            No Goal Threads yet — send a message to any Agent and one will appear here.
          </p>
        ) : (
          <div className="thread-list">
            {threads.map((thread) => (
              <div className="thread-card" key={thread.id}>
                <button className="thread-card-header" onClick={() => toggleThread(thread)}>
                  <div className="thread-card-title">
                    <strong>{thread.title}</strong>
                    <span className={"thread-status thread-status-" + thread.status.toLowerCase()}>
                      {thread.status}
                    </span>
                  </div>
                  <span className="thread-card-meta">
                    {thread.runIds.length} run{thread.runIds.length === 1 ? "" : "s"}
                    {thread.parentThreadId ? " · forked" : ""}
                  </span>
                </button>

                {expandedThreadId === thread.id && (
                  <div className="thread-run-list">
                    {thread.closedReason && (
                      <p className="thread-closed-reason">{thread.closedReason}</p>
                    )}
                    {(runsByThread[thread.id] ?? []).map((run) => (
                      <div key={run.id}>
                        <button
                          className={
                            "thread-run-item " +
                            (selectedRunId === run.id ? "selected" : "")
                          }
                          onClick={() => selectRun(run.id)}
                        >
                          {run.prompt}
                        </button>
                        {selectedRunId === run.id && (
                          <div className="thread-decision">
                            {decisionLoading ? (
                              <span className="goal-thread-empty">Loading decision…</span>
                            ) : decision ? (
                              <>
                                <div className="thread-decision-header">
                                  <span className={"decision-badge decision-" + decision.decision.toLowerCase()}>
                                    {decision.decision}
                                  </span>
                                  <span>{Math.round(decision.confidence * 100)}% confidence</span>
                                </div>
                                <ul className="evidence-list">
                                  <li>{decision.evidence.semanticNote}</li>
                                  <li>
                                    Shared entities:{" "}
                                    {decision.evidence.sharedEntities.length > 0
                                      ? decision.evidence.sharedEntities.join(", ")
                                      : "none"}
                                  </li>
                                  <li>
                                    Workspace overlap: {decision.evidence.workspaceOverlap ? "yes" : "no"}
                                  </li>
                                  <li>
                                    Explicit reference: {decision.evidence.explicitReference ? "yes" : "no"}
                                  </li>
                                  <li>
                                    Goal shift detected: {decision.evidence.goalShiftDetected ? "yes" : "no"}
                                  </li>
                                </ul>
                              </>
                            ) : (
                              <span className="goal-thread-empty">No decision recorded.</span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {(runsByThread[thread.id] ?? []).length === 0 && (
                      <span className="goal-thread-empty">No runs loaded yet.</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
