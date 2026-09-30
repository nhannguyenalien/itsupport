import type { AiWorkflowResult } from "./index.js";

export interface WorkflowState {
  status: "running" | "finished" | "failed";
  stoppedBecause?: string;
}
// Single backend process; the database execution lock also serializes devices.
// Keep terminal state briefly so polling clients can observe failures.
const jobs = new Map<string, WorkflowState>();
export function getWorkflowState(ticketId: string): WorkflowState | null {
  return jobs.get(ticketId) ?? null;
}
export function startWorkflowJob(ticketId: string, run: () => Promise<AiWorkflowResult>, onError: (error: unknown) => void): WorkflowState {
  const existing = jobs.get(ticketId);
  if (existing?.status === "running") return existing;
  const state: WorkflowState = { status: "running" };
  jobs.set(ticketId, state);
  void (async () => {
    try {
      const deadline = Date.now() + 15 * 60_000;
      let result: AiWorkflowResult;
      do { result = await run(); }
      while (result.stoppedBecause === "execution_timeout" && Date.now() < deadline);
      state.status = "finished";
      state.stoppedBecause = result.stoppedBecause;
    } catch (error) {
      state.status = "failed";
      onError(error);
    } finally {
      setTimeout(() => { if (jobs.get(ticketId) === state) jobs.delete(ticketId); }, 60 * 60 * 1000).unref();
    }
  })();
  return state;
}
