# API IT Support

Base URL production:

```text
https://itsupport.schoolsai.work/api
```

Request/response dùng JSON. Không đặt token trong query string hoặc log.

## Xác thực

| Nhóm | Header | Ghi chú |
|---|---|---|
| Dashboard/user | `Authorization: Bearer <FIREBASE_ID_TOKEN>` | Email phải được xác minh; backend ánh xạ Firebase UID vào user và tenant |
| Agent | `Authorization: Bearer <AGENT_TOKEN>` | Token riêng từng thiết bị, cấp đúng một lần khi enrollment |
| Public | Không có | Chỉ `GET /health`, `POST /auth/attempt`, `POST /enrollment/register` và OAuth callback |

Role: `admin` quản lý enrollment, revoke/pause và cấu hình tenant; `technician` thao tác ticket/tool; `member` chủ yếu đọc.

## Enrollment

### Tạo token một lần

`POST /enrollment-tokens` — Firebase token, role admin.

```json
{ "tenantId": "<TENANT_UUID>" }
```

Response `201`:

```json
{
  "tokenId": "<UUID>",
  "token": "<RAW_TOKEN_SHOWN_ONCE>",
  "expiresAt": "2026-09-24T12:00:00.000Z"
}
```

### Đăng ký thiết bị

`POST /enrollment/register` — public, token một lần hết hạn sau 10 phút.

```json
{
  "token": "<RAW_TOKEN>",
  "hostname": "pc-ke-toan-01",
  "publicKey": "-----BEGIN PUBLIC KEY-----...",
  "osVersion": "Windows 11 24H2",
  "agentVersion": "0.2.0",
  "platform": "windows"
}
```

Response `201` trả `deviceId`, certificate/CA, `agentUrl` và `agentToken`. `agentToken` không được trả lại lần thứ hai.

## Endpoint chính

| Method | Path | Quyền/xác thực | Mục đích |
|---|---|---|---|
| GET | `/health` | Public | Health check DB/API |
| POST | `/auth/attempt` | Public, rate limit | Kiểm tra giới hạn login/register/reset |
| POST | `/auth/register` | Firebase | Tạo workspace/user sau đăng ký Firebase |
| GET | `/auth/me` | Firebase | User, tenant và role hiện tại |
| GET | `/devices?tenantId=...` | Firebase | Danh sách thiết bị tenant |
| POST | `/devices/:deviceId/heartbeat` | Agent | Cập nhật trạng thái online |
| GET | `/devices/:deviceId/tool-calls/pending` | Agent | Agent lấy việc chờ xử lý |
| POST | `/tool-calls/:toolCallId/result` | Agent | Agent trả kết quả |
| POST | `/devices/:deviceId/revoke` | Admin | Thu hồi agent token/certificate |
| POST | `/devices/:deviceId/pause` | Admin | Chặn tác vụ ghi |
| POST | `/devices/:deviceId/unpause` | Admin | Cho phép lại tác vụ ghi |
| GET/POST | `/tickets` | Firebase | Liệt kê/tạo ticket |
| GET | `/tickets/:ticketId` | Firebase | Chi tiết ticket, messages, calls, approvals |
| POST | `/tickets/:ticketId/messages` | Technician | Thêm tin nhắn |
| POST | `/tickets/:ticketId/ai-step` | Technician | Chạy một bước điều phối AI |
| POST | `/tickets/:ticketId/tool-calls` | Technician | Tạo tool call |
| POST | `/approvals/:approvalId/approve` | Technician | Duyệt thao tác |
| POST | `/approvals/:approvalId/reject` | Technician | Từ chối thao tác |
| GET | `/metrics?tenantId=...` | Firebase | Metrics tenant |
| GET | `/tool-registry` | Firebase | Danh sách tool backend hỗ trợ |

Các endpoint tenant, computer-use, screenshot và OAuth cũng được bảo vệ bằng Firebase token và tenant ownership. Xem source route tại `backend/src/*/routes.ts` nếu cần schema chi tiết; route dùng Zod và trả `400` cho payload sai.

## Ví dụ agent heartbeat

```bash
curl -i -X POST \
  -H 'Authorization: Bearer <AGENT_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{}' \
  'https://itsupport.schoolsai.work/api/devices/<DEVICE_UUID>/heartbeat'
```

## Mã lỗi thường gặp

- `400`: schema/payload không hợp lệ.
- `401`: thiếu, hết hạn, sai hoặc đã revoke credential.
- `403 EMAIL_NOT_VERIFIED`: Firebase email chưa xác minh.
- `403 WORKSPACE_REQUIRED`: Firebase user chưa đăng ký workspace backend.
- `403`: role không đủ hoặc truy cập tenant khác.
- `404`: resource không thuộc tenant hiện tại (cố ý không tiết lộ resource tenant khác).
- `429`: vượt rate limit login/register/reset.
