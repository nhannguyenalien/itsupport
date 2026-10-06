"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

export default function RemoteSupport({ deviceId, compact = false }: { deviceId: string; compact?: boolean }) {
  const { tx } = useLanguage();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.remoteSupport>> | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setData(null); setError(false); setSaving(false); busy.current = false;
    async function refresh() {
      if (busy.current) return;
      const revision = ++requestVersion.current;
      try {
        const result = await api.remoteSupport(deviceId);
        if (current === generation.current && revision === requestVersion.current && !busy.current) { setData(result); setError(false); }
      } catch { if (current === generation.current && revision === requestVersion.current && !busy.current) setError(true); }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { ++generation.current; clearInterval(timer); };
  }, [deviceId]);

  async function toggle() {
    if (!data || busy.current) return;
    const current = generation.current;
    ++requestVersion.current;
    busy.current = true; setSaving(true); setError(false);
    try {
      const result = await api.setRemoteSupport(deviceId, !data.enabled);
      if (current === generation.current) setData(result);
    } catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) { busy.current = false; setSaving(false); } }
  }

  const terminal = data?.mode === "terminal";
  const title = terminal ? "remote.terminalTitle" : "remote.title";
  if (compact) {
    // One line for the conversation header: the switch, a status tooltip and
    // the console link when enabled.
    const hint = data ? tx(!data.ready ? "remote.notReady" : data.enabled ? (terminal ? "remote.terminalEnabledHint" : "remote.enabledHint") : (terminal ? "remote.terminalDisabledHint" : "remote.disabledHint")) : undefined;
    return <div className="remote-compact" title={hint}>
      <span>{tx(title)}</span>
      <button type="button" role="switch" aria-checked={data?.enabled ?? false} aria-label={tx(title)}
        className={`remote-switch ${data?.enabled ? "on" : ""}`}
        disabled={!data || (!data.ready && !data.enabled) || saving} onClick={() => void toggle()}>
        <i aria-hidden="true" />
      </button>
      {saving && <small>{tx("remote.updating")}</small>}
      {error && <small role="alert" className="remote-error">{tx("remote.error")}</small>}
      {data?.enabled && data.url && <a href={data.url} target="_blank" rel="noopener noreferrer">{tx(terminal ? "remote.openTerminal" : "remote.open")} ↗</a>}
      {!terminal && data?.enabled && data.terminalUrl && <a href={data.terminalUrl} target="_blank" rel="noopener noreferrer">{tx("remote.openTerminal")} ↗</a>}
    </div>;
  }

  return <section style={{ marginTop: 12, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 12 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <strong>{tx(title)}</strong>
      <button type="button" role="switch" aria-checked={data?.enabled ?? false} aria-label={tx(title)}
        disabled={!data || (!data.ready && !data.enabled) || saving} onClick={() => void toggle()}
        style={{ minWidth: 80, borderRadius: 20, background: data?.enabled ? "#15803d" : "#64748b", color: "white", padding: "8px 16px" }}>
        {tx(saving ? "remote.updating" : !data ? "remote.loading" : data.enabled ? "remote.on" : "remote.off")}
      </button>
    </div>
    {error && <p role="alert">{tx("remote.error")}</p>}
    {data && <p className="muted">{tx(!data.ready ? "remote.notReady" : data.enabled ? (terminal ? "remote.terminalEnabledHint" : "remote.enabledHint") : (terminal ? "remote.terminalDisabledHint" : "remote.disabledHint"))}</p>}
    {data?.enabled && data.url && <a href={data.url} target="_blank" rel="noopener noreferrer">{tx(terminal ? "remote.openTerminal" : "remote.open")} ↗</a>}
      {!terminal && data?.enabled && data.terminalUrl && <a href={data.terminalUrl} target="_blank" rel="noopener noreferrer">{tx("remote.openTerminal")} ↗</a>}
  </section>;
}
