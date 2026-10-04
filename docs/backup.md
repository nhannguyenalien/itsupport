# Backup chủ động (restic)

Agent Windows (từ 0.4.0) chạy [restic](https://restic.net) theo chính sách lưu ở backend.
restic tự mã hoá, dedup và gửi dữ liệu thẳng tới repository — dữ liệu backup **không đi qua backend**.

## Luồng

1. Admin/kỹ thuật viên mở **Thiết bị → Backup (restic)** của máy, nhập repository, mật khẩu, thư mục, lịch, retention.
2. Backend mã hoá thông tin xác thực (AES-GCM, khoá `OAUTH_TOKEN_ENC_KEY`) vào `backup_policies`; không API nào trả lại secret.
3. Scheduler (`backend/src/backup/index.ts`, mỗi phút) xếp `backup.run` cho máy online, chưa bị tạm dừng, đã tới hạn. `params` lưu trong `tool_calls` luôn rỗng; secret chỉ được chèn khi agent poll `/tool-calls/pending` qua kênh mTLS.
4. Executor chạy `restic` với dòng lệnh cố định (không shell), trả về ngay `started`; tiến độ/kết quả đọc bằng `backup.status` (scheduler tự hỏi mỗi 2 phút khi đang chạy, 6 giờ khi rảnh).
5. `backup.*` thuộc domain `agent`: **AI không được gọi**, chỉ người dùng/scheduler.

## Repository hỗ trợ

| Loại | Ví dụ | Khoá cần |
|---|---|---|
| REST server | `rest:https://backup.example.com/may-ke-toan-01` | user/password (`RESTIC_REST_*`) |
| S3 / R2 / Wasabi | `s3:https://s3.amazonaws.com/bucket/may-01` | access key + secret |
| Backblaze B2 | `b2:bucket:may-01` | account ID + key |

SFTP bị loại có chủ đích (restic phải gọi `ssh`).

## Cài restic lên máy

Lần chạy đầu agent tự tải `restic.exe` nếu backend đặt hai biến môi trường:

```
RESTIC_WINDOWS_URL=https://itsupport.example.com/downloads/agent/restic-windows-amd64.exe
RESTIC_WINDOWS_SHA256=<sha256 của file>
```

Đặt file `restic.exe` (bản chính thức, giải nén từ zip release, đối chiếu với `SHA256SUMS` của restic) vào `frontend/public/downloads/agent/restic-windows-amd64.exe` (file bị `.gitignore`, phải copy lên server cùng thư mục `downloads/agent/`). Hiện dùng restic 0.19.1, SHA-256 `b0dd1fd2…7830`. Agent chỉ chấp nhận https và đúng SHA-256.

## Repository server tự host (tuỳ chọn)

```bash
htpasswd -B -c infra/secrets/restic_htpasswd may-ke-toan-01
docker compose --profile backup up -d restic-rest   # nghe 127.0.0.1:8000
```

Đặt reverse proxy/tunnel HTTPS trước cổng 8000. Server chạy `--append-only --private-repos`:
máy khách bị mã độc cũng không xoá được snapshot cũ. Hệ quả: `forget --prune` của agent sẽ bị từ chối
trên repo này; dọn dẹp bằng `restic forget --prune` chạy phía server với khoá quản trị (hoặc dùng S3/B2 để retention tự chạy).

## Khôi phục (restore)

Chỉ **quản trị viên** thấy kết quả và thực hiện được. Trong **Backup → Khôi phục dữ liệu**:

1. "Tải danh sách snapshot" → agent chạy `backup.snapshots` (chỉ đọc) và trả 50 snapshot gần nhất.
2. Chọn snapshot, nhập thư mục đích, (tuỳ chọn) giới hạn vài đường dẫn, tick xác nhận → `backup.restore` (risk `high`).
3. Theo dõi trạng thái trong cùng panel (scheduler hỏi `backup.status` mỗi 2 phút trong lúc khôi phục).

Rào chắn an toàn:
- **Không bao giờ ghi đè tại chỗ**: agent chỉ giải nén vào thư mục *mới hoặc trống*; từ chối ổ/gốc hệ thống, `Windows`, `Program Files`, và thư mục của agent. Người dùng tự chép phần cần về chỗ cũ.
- Backup và restore không chạy cùng lúc trên một máy.
- Mỗi yêu cầu restore ghi audit `device.backup_restore_requested` (snapshot, thư mục đích, đường dẫn).
- Vẫn khôi phục được khi chính sách backup đã bị tắt (cần dữ liệu thì vẫn lấy lại được).
- Cảnh báo: dữ liệu khôi phục nằm *không mã hoá* trong thư mục đích; xoá sau khi dùng xong.

## Cảnh báo quá hạn

`GET /backups` trả `health` cho từng máy (`ok`, `running`, `overdue`, `never`, `failed`, `disabled`, `unsupported`). Quá hạn = quá 2 chu kỳ (tối thiểu 24 giờ) không có lần thành công. Trang Thiết bị hiện banner, và audit log ghi `device.backup_alert` (tối đa 1 lần/máy/24 giờ).

## Giới hạn hiện tại

- Chỉ Windows; chưa khôi phục tại chỗ (ghi đè) và chưa có kiểm tra restore định kỳ tự động.
- Mất mật khẩu repository = mất dữ liệu: lưu bản dự phòng ngoài hệ thống.
- Backup đang chạy bị dừng nếu dịch vụ agent khởi động lại; lần tới scheduler sẽ chạy lại.
- Chưa có kênh gửi cảnh báo ra ngoài (email/Slack).
