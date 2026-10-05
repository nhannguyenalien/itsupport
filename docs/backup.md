# Backup chủ động (restic)

Agent Windows, macOS và Linux (từ 0.4.1) chạy [restic](https://restic.net) theo chính sách lưu ở backend.
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

## macOS

Agent macOS chạy trong phiên đăng nhập của người dùng (LaunchAgent) nên backup dữ liệu của chính người dùng đó. Cấp **Full Disk Access** cho binary `executor` trong System Settings → Privacy & Security, nếu không macOS (TCC) sẽ chặn Desktop/Documents/iCloud. Mẫu mặc định: thư mục `/Users`, loại trừ `Library/Caches`, `.Trash`. Binary restic tải dạng `.bz2` (`RESTIC_DARWIN_AMD64/ARM64_*`). Khôi phục vào thư mục mới/trống, ví dụ `/Users/Shared/Restore-…`; không dùng VSS (chỉ có trên Windows).

## Linux và Coolify

Agent Linux chạy bằng root nên đọc được `/data/coolify` và `/var/lib/docker`. Restic Linux được tải về dạng `.bz2` chính thức (SHA-256 ghim trên chính file `.bz2`); đặt `restic-linux-amd64.bz2` / `restic-linux-arm64.bz2` cạnh bản Windows và khai báo `RESTIC_LINUX_AMD64_URL/SHA256`, `RESTIC_LINUX_ARM64_URL/SHA256` (xem `.env.example`).

Trong **Backup** của máy Linux bấm **Mẫu Coolify** để điền sẵn:
- Thư mục: `/data/coolify` (cấu hình, khoá SSH, `.env`) và `/var/lib/docker/volumes`.
- Loại trừ: `*.tmp`, `*.log`. Không backup `overlay2`/image (dựng lại được).

**Postgres trong container:** chép thẳng thư mục dữ liệu Postgres đang chạy có thể cho bản khôi phục không khởi động được, nên mỗi lần backup agent **dump trước** rồi đưa file dump vào snapshot. Khai báo mỗi dòng `container:user:database`:

```
postgres-abc123:postgres:appdb      # pg_dump -Fc, file <container>__appdb.dump
postgres-abc123:postgres:           # bỏ trống database = pg_dumpall, file <container>__ALL.sql
```

Lấy tên container bằng `docker ps --format '{{.Names}} {{.Image}}'`. Chỉ chạy đúng `docker exec <container> pg_dump|pg_dumpall` với tên khớp mẫu chặt (không thể thành lệnh tuỳ ý). Dump nằm ở `/root/.config/support-agent/dumps/` và được thay mới mỗi lần. **Nếu một dump lỗi, lần backup bị tính là lỗi** (file vẫn được backup nhưng bản database thiếu/cũ) và kích hoạt cảnh báo.

Khôi phục database: restore snapshot vào thư mục trống như thường lệ, rồi tự chạy `pg_restore`/`psql` từ file dump vào container Postgres.

Lưu ý: restic vẫn chép cả volume Postgres thô trong `/var/lib/docker/volumes`; bản đó không đáng tin để khôi phục DB (chỉ tốn dung lượng, restic khử trùng lặp). Dùng file dump. Backup file không thay cho snapshot ổ đĩa của nhà cung cấp VPS khi cần dựng lại cả máy.

## Email cảnh báo

Cần SMTP trên server (biến môi trường của backend):

```
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM="IT Support <alerts@example.com>"
```

Quản trị viên mở **Thiết bị → Email cảnh báo backup**, nhập tối đa 10 địa chỉ, bật và bấm "Gửi email thử" (chỉ gửi tới địa chỉ đã lưu). Cứ 30 phút hệ thống quét một lần và gửi **một email tóm tắt cho mỗi workspace**; mỗi máy chỉ được gửi lại sau 24 giờ nếu vẫn có vấn đề (`device.backup_alert_emailed` trong audit). Nếu SMTP lỗi, hệ thống thử lại ở lần quét sau chứ không bỏ qua cảnh báo. Email là văn bản thuần để tên máy không thể chèn mã.

## Giới hạn hiện tại

- Chỉ Windows, macOS và Linux; chỉ dump Postgres (chưa MySQL/MariaDB); chưa khôi phục tại chỗ (ghi đè) và chưa có kiểm tra restore định kỳ tự động.
- Mất mật khẩu repository = mất dữ liệu: lưu bản dự phòng ngoài hệ thống.
- Backup đang chạy bị dừng nếu dịch vụ agent khởi động lại; lần tới scheduler sẽ chạy lại.
- Cảnh báo ra ngoài mới có email (chưa có Slack/webhook) và chưa có email "đã phục hồi".
