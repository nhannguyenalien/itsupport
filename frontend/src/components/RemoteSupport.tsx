"use client";

import { useEffect, useState } from "react";
import { api, type AuthUser } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

export default function RemoteSupport({ deviceId }: { deviceId: string }) {
  const { tx } = useLanguage();
  const [role, setRole] = useState<AuthUser["role"]>("member");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.remoteSupport>> | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null); setValue(""); setRole("member"); setError(false);
    void api.me().then(async ({ user }) => {
      if (!active) return;
      setRole(user.role);
      if (user.role === "member") return;
      const result = await api.remoteSupport(deviceId);
      if (active) { setData(result); setValue(result.nodeId ?? ""); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [deviceId]);
  if (role === "member") return null;

  async function save() {
    setSaving(true); setError(false);
    try {
      let id = value.trim();
      if (id.startsWith("https://")) {
        const url = new URL(id);
        if (url.origin !== data?.consoleUrl) throw new Error("Wrong server");
        id = url.searchParams.get("gotonode") ?? url.searchParams.get("node") ?? "";
        if (!id) throw new Error("Missing node");
      }
      if (id.startsWith("node//")) id = id.slice(6);
      await api.setRemoteSupport(deviceId, id || null);
      const result = await api.remoteSupport(deviceId);
      setData(result); setValue(result.nodeId ?? "");
    } catch { setError(true); }
    finally { setSaving(false); }
  }

  return <details style={{ marginTop: 10 }}>
    <summary>{tx("remote.title")}</summary>
    {error && <p role="alert">{tx("remote.error")}</p>}
    {!data ? (!error && <p>{tx("Đang tải thiết bị…")}</p>) : !data.consoleUrl ? <p>{tx("remote.unavailable")}</p> : <>
      <p className="muted">{tx(data.nodeId ? "remote.registered" : "remote.unregistered")}</p>
      <p>{tx("remote.consent")}</p>
      <p><a href={data.url ?? data.consoleUrl} target="_blank" rel="noopener noreferrer">{tx(data.url ? "remote.open" : "remote.console")} ↗</a></p>
      {role === "admin" && <>
        <p className="muted">{tx("remote.install")}</p>
        <label>{tx("remote.node")}<input style={{ width: "100%", marginTop: 6 }} value={value} onChange={e => setValue(e.target.value)} placeholder="node//…" /></label>
        <button disabled={saving} onClick={() => void save()}>{tx(saving ? "Đang tạo…" : "remote.save")}</button>
      </>}
    </>}
  </details>;
}
