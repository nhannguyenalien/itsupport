"use client";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Tenant } from "@/lib/api";

export default function DashboardPage() {
  const { tenantId, ready } = useTenant();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    api.getTenant(tenantId).then(setTenant).catch((e) => setError(String(e)));
  }, [tenantId]);

  if (!ready) return null;

  async function toggleAi() {
    if (!tenant) return;
    try {
      if (tenant.ai_enabled) await api.disableAi(tenant.id);
      else await api.enableAi(tenant.id);
      setTenant(await api.getTenant(tenant.id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleComputerUseAutonomous() {
    if (!tenant) return;
    try {
      if (tenant.computer_use_autonomous_enabled) await api.disableComputerUseAutonomous(tenant.id);
      else await api.enableComputerUseAutonomous(tenant.id);
      setTenant(await api.getTenant(tenant.id));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>AI Windows Support Agent</h1>
      <p className="muted">Workspace của bạn được bảo vệ bằng phiên đăng nhập.</p>

      {error && <div className="card error-text">{error}</div>}

      {tenant && (
        <div className="card">
          <div className="row">
            <div><strong>{tenant.name}</strong><div className="muted">{tenant.id}</div></div>
          </div>
          <hr className="divider" />
          <div className="row">
            <div>
              <div>AI status: <span className={tenant.ai_enabled ? "badge badge-online" : "badge badge-offline"}>{tenant.ai_enabled ? "enabled" : "disabled"}</span></div>
              <div className="muted">Disabling blocks every AI-initiated tool call at the policy engine.</div>
            </div>
            <button className={tenant.ai_enabled ? "danger" : "primary"} onClick={toggleAi}>{tenant.ai_enabled ? "Disable Tenant AI" : "Enable Tenant AI"}</button>
          </div>
          <hr className="divider" />
          <div className="row">
            <div>
              <div>Computer-use autonomy: <span className={tenant.computer_use_autonomous_enabled ? "badge badge-online" : "badge badge-offline"}>{tenant.computer_use_autonomous_enabled ? "autonomous" : "per-action approval"}</span></div>
              <div className="muted">Autonomous click/type actions run without pausing, except detected card numbers.</div>
            </div>
            <button className={tenant.computer_use_autonomous_enabled ? "danger" : "primary"} onClick={toggleComputerUseAutonomous}>{tenant.computer_use_autonomous_enabled ? "Require approval for every action" : "Enable autonomous computer-use"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
