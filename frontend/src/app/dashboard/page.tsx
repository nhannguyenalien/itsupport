"use client";

import { useLanguage } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { useTenant } from "@/lib/useTenant";
import { api, type Tenant } from "@/lib/api";

export default function DashboardPage() {
  const { tx } = useLanguage();
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

  async function toggleShellRun() {
    if (!tenant) return;
    try {
      await api.setTenantShellRun(tenant.id, !tenant.shell_run_enabled);
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
      <p className="muted">{tx("Workspace của bạn được bảo vệ bằng phiên đăng nhập.")}</p>

      {error && <div className="card error-text">{tx(error)}</div>}

      {tenant && (
        <div className="card">
          <div className="row">
            <div><strong>{tenant.name}</strong><div className="muted">{tenant.id}</div></div>
          </div>
          <hr className="divider" />
          <div className="row">
            <div>
              <div>{tx("AI status:")} <span className={tenant.ai_enabled ? "badge badge-online" : "badge badge-offline"}>{tenant.ai_enabled ? tx("enabled") : tx("disabled")}</span></div>
              <div className="muted">{tx("Disabling blocks every AI-initiated tool call at the policy engine.")}</div>
            </div>
            <button className={tenant.ai_enabled ? "danger" : "primary"} onClick={toggleAi}>{tenant.ai_enabled ? tx("Disable Tenant AI") : tx("Enable Tenant AI")}</button>
          </div>
          <hr className="divider" />
          <div className="row">
            <div>
              <div>{tx("Computer-use autonomy:")} <span className={tenant.computer_use_autonomous_enabled ? "badge badge-online" : "badge badge-offline"}>{tenant.computer_use_autonomous_enabled ? tx("autonomous") : tx("per-action approval")}</span></div>
              <div className="muted">{tx("Autonomous click/type actions run without pausing, except detected card numbers.")}</div>
            </div>
            <button className={tenant.computer_use_autonomous_enabled ? "danger" : "primary"} onClick={toggleComputerUseAutonomous}>{tenant.computer_use_autonomous_enabled ? tx("Require approval for every action") : tx("Enable autonomous computer-use")}</button>
          </div>
          <hr className="divider" />
          <div className="row">
            <div>
              <div>{tx("Chạy lệnh trên máy Linux:")} <span className={tenant.shell_run_enabled ? "badge badge-online" : "badge badge-offline"}>{tenant.shell_run_enabled ? tx("enabled") : tx("disabled")}</span></div>
              <div className="muted">{tx("Cho AI chạy lệnh trên máy Linux. Mỗi máy còn phải được bật riêng. Lệnh chỉ đọc chạy ngay, lệnh khác cần bạn duyệt từng lần.")}</div>
            </div>
            <button className={tenant.shell_run_enabled ? "danger" : "primary"} onClick={toggleShellRun}>{tenant.shell_run_enabled ? tx("Tắt chạy lệnh") : tx("Bật chạy lệnh")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
