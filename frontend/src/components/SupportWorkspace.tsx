"use client";

import { useLanguage, LanguageSwitcher } from "@/lib/i18n";

import { useEffect, useRef, useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { api, type Device, type Ticket } from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import TicketChat from "./TicketChat";
import DeviceManager from "./DeviceManager";

export default function SupportWorkspace({ initialTicketId }: { initialTicketId?: string }) {
  const { tx, locale } = useLanguage();
  const { tenantId } = useTenant();
  const [devices, setDevices] = useState<Device[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState(initialTicketId ?? null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [manage, setManage] = useState(false);
  const selection = useRef(0);
  const initialized = useRef(false);

  useEffect(() => {
    if (!tenantId) return;
    let active = true;
    async function refresh() {
      try {
        const [ds, ts] = await Promise.all([api.listDevices(tenantId!), api.listTickets(tenantId!)]);
        if (!active) return;
        setDevices(ds); setTickets(ts); setError("");
        if (!initialized.current) {
          initialized.current = true;
          const existing = initialTicketId ? ts.find((t) => t.id === initialTicketId) : undefined;
          const first = ds.find((d) => d.status === "online" && !d.revoked) ?? ds[0];
          const deviceId = existing?.device_id ?? first?.id ?? null;
          setSelected(deviceId);
          if (!initialTicketId) setTicketId(ts.filter((t) => t.device_id === deviceId).sort((a,b) => b.created_at.localeCompare(a.created_at))[0]?.id ?? null);
        }
      } catch { if (active) setError("Không tải được danh sách máy. Đang thử kết nối lại…"); }
      finally { if (active) setLoading(false); }
    }
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tenantId, initialTicketId]);

  function selectDevice(device: Device) {
    selection.current += 1;
    setOpening(false); setSelected(device.id); setError("");
    setTicketId(tickets.filter((t) => t.device_id === device.id).sort((a,b) => b.created_at.localeCompare(a.created_at))[0]?.id ?? null);
  }

  async function newChat() {
    if (!tenantId || !selected || opening) return;
    const version = ++selection.current;
    setOpening(true); setError("");
    try {
      const created = await api.createTicket({ tenantId, deviceId: selected, title: tx("supportDevice", { name: devices.find((d) => d.id === selected)?.hostname ?? tx("thiết bị") }) });
      setTickets((current) => [created, ...current]);
      if (version === selection.current) setTicketId(created.id);
    } catch { if (version === selection.current) setError("Không mở được chat. Vui lòng thử lại."); }
    finally { if (version === selection.current) setOpening(false); }
  }

  const device = devices.find((d) => d.id === selected);
  const history = tickets.filter((t) => t.device_id === selected).sort((a,b) => b.created_at.localeCompare(a.created_at));
  return <div className="support-workspace">
    <aside className="machine-sidebar">
      <div className="workspace-brand">✦ <strong>IT Support</strong><span>{tx("Trợ lý cho máy của bạn")}</span></div>
      <div className="machine-list-heading"><span>{tx("Máy của bạn")}</span><button onClick={() => setManage(true)} aria-label={tx("Thêm hoặc quản lý máy")}>＋</button></div>
      <div className="machine-list">
        {loading && <p>{tx("Đang tải máy…")}</p>}
        {!loading && devices.length === 0 && <p>{tx("Chưa có máy kết nối. Nhấn ＋ để thêm máy.")}</p>}
        {devices.map((d) => <button key={d.id} className={`machine-item ${selected === d.id ? "selected" : ""}`} aria-pressed={selected === d.id} onClick={() => selectDevice(d)}><span className="machine-icon">▣</span><span><strong>{d.hostname}</strong><small><i className={`machine-dot ${d.status === "online" && !d.revoked ? "online" : ""}`} />{d.revoked ? tx("Đã thu hồi") : d.actions_paused ? tx("Đã tạm dừng") : d.status === "online" ? tx("Đang kết nối") : tx("Ngoại tuyến")}</small></span></button>)}
      </div>
      <div className="sidebar-footer"><LanguageSwitcher /><button onClick={() => setManage(true)}>{tx("Thêm / quản lý máy")}</button><button onClick={() => void signOut(auth)}>{tx("Đăng xuất")}</button></div>
    </aside>
    <section className="workspace-conversation">
      <div className="conversation-toolbar"><div><strong>{device?.hostname ?? tx("Hỗ trợ IT")}</strong><small>{device ? device.status === "online" ? tx("Máy đang kết nối") : tx("Máy ngoại tuyến · bạn vẫn có thể xem lịch sử") : tx("Chọn một máy ở bên trái")}</small></div><div className="conversation-actions">{history.length > 0 && <select aria-label={tx("Lịch sử trò chuyện")} value={ticketId ?? ""} onChange={(e) => { selection.current += 1; setOpening(false); setTicketId(e.target.value); }}><option value="" disabled>{tx("Lịch sử chat")}</option>{history.map((t) => <option key={t.id} value={t.id}>{new Date(t.created_at).toLocaleDateString(locale)} · {t.title}</option>)}</select>}<button disabled={!selected || opening || device?.revoked} onClick={() => void newChat()}>{opening ? tx("Đang mở…") : tx("+ Chat mới")}</button></div></div>
      {error && <p role="alert" className="workspace-error">{tx(error)}</p>}
      {ticketId ? <TicketChat key={ticketId} ticketId={ticketId} /> : <div className="workspace-empty"><span>✦</span><h1>{device ? tx("supportDevice", { name: device.hostname }) : tx("Tất cả máy, một nơi hỗ trợ")}</h1><p>{device ? tx("Mở chat và mô tả vấn đề. Lệnh thực hiện và kết quả sẽ xuất hiện ngay trong cuộc trò chuyện.") : tx("Thêm máy để bắt đầu trò chuyện với trợ lý IT.")}</p><button className="primary" disabled={opening || device?.revoked} onClick={() => device ? void newChat() : setManage(true)}>{device ? tx("Bắt đầu chat") : tx("Thêm máy")}</button></div>}
    </section>
    {manage && <div className="workspace-modal" role="dialog" aria-modal="true" aria-label={tx("Thêm và quản lý máy")} onKeyDown={(e) => { if (e.key === "Escape") setManage(false); }}><div className="workspace-modal-content"><button className="modal-close" autoFocus onClick={() => setManage(false)}>{tx("Đóng ×")}</button><DeviceManager /></div></div>}
  </div>;
}
