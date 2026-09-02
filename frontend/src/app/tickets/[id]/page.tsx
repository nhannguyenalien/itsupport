"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type TicketDetail, type ToolDefinition } from "@/lib/api";

function RiskBadge({ risk }: { risk: string }) {
  return <span className={`badge badge-risk-${risk}`}>{risk}</span>;
}

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const ticketId = params.id;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [messageBody, setMessageBody] = useState("");

  const [selectedTool, setSelectedTool] = useState("");
  const [initiatedBy, setInitiatedBy] = useState<"ai" | "human">("ai");
  const [paramsJson, setParamsJson] = useState("{}");
  const [reasoning, setReasoning] = useState("");

  async function load() {
    try {
      setTicket(await api.getTicket(ticketId));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    api
      .listTools()
      .then((r) => {
        setTools(r.tools);
        if (r.tools[0]) setSelectedTool(r.tools[0].tool);
      })
      .catch((e) => setError(String(e)));
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  if (!ticket) return <p className="muted">Loading…</p>;

  async function sendMessage() {
    if (!messageBody.trim()) return;
    try {
      await api.addMessage(ticketId, { authorType: "user", body: messageBody });
      setMessageBody("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function requestToolCall() {
    setError(null);
    let parsedParams: Record<string, unknown> = {};
    try {
      parsedParams = paramsJson.trim() ? JSON.parse(paramsJson) : {};
    } catch {
      setError("params must be valid JSON");
      return;
    }
    try {
      await api.requestToolCall(ticketId, {
        initiatedBy,
        tool: selectedTool,
        params: parsedParams,
        reasoning: reasoning || undefined,
      });
      setReasoning("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function decide(approvalId: string, approve: boolean) {
    try {
      if (approve) await api.approveApproval(approvalId);
      else await api.rejectApproval(approvalId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function requestTakeover() {
    setError(null);
    try {
      const { url } = await api.getTakeoverLink(ticketId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      // Honest failure from the backend (no MeshCentral agent on this device
      // yet, or MESHCENTRAL_URL not configured) — surfaced as-is, not hidden.
      setError(String(e));
    }
  }

  const pendingApprovals = ticket.approvals.filter((a) => a.status === "pending");

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{ticket.title}</h1>
          <p className="muted">
            status: <strong>{ticket.status}</strong> ·{" "}
            {ticket.device_id ? `device ${ticket.device_id}` : `platform connection ${ticket.platform_connection_id}`}
          </p>
        </div>
        {ticket.device_id && <button onClick={requestTakeover}>Remote takeover (MeshCentral)</button>}
      </div>
      {error && <div className="card" style={{ color: "#b91c1c" }}>{error}</div>}

      {pendingApprovals.length > 0 && (
        <div className="card" style={{ borderColor: "#fbbf24", background: "#fffbeb" }}>
          <h3>Pending approval{pendingApprovals.length > 1 ? "s" : ""}</h3>
          {pendingApprovals.map((a) => (
            <div key={a.id} style={{ marginBottom: "0.75rem" }}>
              <div>
                <strong>{a.tool}</strong> — <code>{JSON.stringify(a.params)}</code>
              </div>
              {a.reasoning && <div className="muted">&quot;{a.reasoning}&quot;</div>}
              <div style={{ marginTop: "0.4rem", display: "flex", gap: "0.5rem" }}>
                <button className="primary" onClick={() => decide(a.id, true)}>
                  Approve
                </button>
                <button className="danger" onClick={() => decide(a.id, false)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Chat</h3>
        {ticket.messages.length === 0 && <p className="muted">No messages yet.</p>}
        {ticket.messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.author_type}`}>
            <div className="muted" style={{ fontSize: "0.75rem" }}>
              {m.author_type}
            </div>
            {m.body}
          </div>
        ))}
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <input
            placeholder="Type a message…"
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={sendMessage}>
            Send
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Tool calls</h3>
        {ticket.toolCalls.length === 0 && <p className="muted">None yet.</p>}
        {ticket.toolCalls.map((tc) => (
          <div key={tc.id} className="row" style={{ borderBottom: "1px solid #f3f4f6", padding: "0.4rem 0" }}>
            <div>
              <strong>{tc.tool}</strong> <RiskBadge risk={tc.risk} />
              {tc.parent_tool_call_id && <span className="muted"> (verification step)</span>}
              <div className="muted">{JSON.stringify(tc.params)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div>{tc.result ?? "pending…"}</div>
              {tc.verification_status !== "not_required" && (
                <div className={`muted`}>verification: {tc.verification_status}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Request a tool call</h3>
        <p className="muted">
          Manual form standing in for AI orchestration (not wired to an LLM yet — see docs/v0.1-spec.md status). Lets you
          exercise the real policy engine end to end.
        </p>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <select value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value as "ai" | "human")}>
            <option value="ai">initiated by: ai</option>
            <option value="human">initiated by: human</option>
          </select>
          <select value={selectedTool} onChange={(e) => setSelectedTool(e.target.value)}>
            {tools.map((t) => (
              <option key={t.tool} value={t.tool}>
                {t.tool} ({t.risk})
              </option>
            ))}
          </select>
        </div>
        <input
          placeholder="reasoning (optional, shown to approver)"
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          style={{ width: "100%", marginBottom: "0.5rem" }}
        />
        <textarea
          value={paramsJson}
          onChange={(e) => setParamsJson(e.target.value)}
          rows={3}
          style={{ width: "100%", fontFamily: "monospace", marginBottom: "0.5rem" }}
        />
        <button className="primary" onClick={requestToolCall}>
          Request
        </button>
      </div>
    </div>
  );
}
