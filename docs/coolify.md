# Chạy IT Support trên Coolify

Bản triển khai Coolify dùng `docker-compose.coolify.yml` ở thư mục gốc repo. Bản `infra/docker-compose.yml` (macmini) giữ nguyên để làm đường lui.

> Đã kiểm thử cục bộ nhưng **chưa chạy trên một Coolify thật** (xem "Đã kiểm chứng" cuối tài liệu). Làm theo thứ tự, kiểm tra từng bước, và giữ macmini chạy song song cho tới khi xong phần "Kiểm tra sau deploy".

## Khác gì so với bản macmini

| | macmini | Coolify |
|---|---|---|
| Secret | file trong `infra/secrets/` | biến môi trường (secret file được giải mã vào tmpfs lúc khởi động) |
| TLS | Cloudflare Tunnel → Caddy | Traefik của Coolify → Caddy |
| Cổng host | `127.0.0.1:18080/18443` | không mở cổng; domain trỏ vào service `caddy` |
| Agent xác thực | bearer token hoặc mTLS (:8443) | **chỉ bearer token qua HTTPS** (không có mTLS) |
| File agent/restic | thư mục `frontend/public/downloads/agent` trên máy | thư mục trên host (`DOWNLOADS_DIR`) mount vào Caddy |
| Tự deploy | timer systemd | webhook / auto-deploy của Coolify |

**Vì sao vẫn giữ Caddy:** backend tin header `X-Agent-Cert-Serial` trên các route của agent. Nếu backend bị lộ thẳng ra Traefik, ai gửi header đó với một serial đoán trúng sẽ giả được thiết bị. Caddy xoá header này trước khi chuyển tiếp. **Không gán domain trực tiếp cho `backend`.**

## 1. Chuẩn bị

- Coolify đã kết nối GitHub (private repo `nhannguyenalien/itsupport` cần GitHub App hoặc deploy key).
- Domain trỏ về server Coolify (nếu giữ nguyên domain đang dùng để agent cũ vẫn kết nối được, xem mục 5).
- Từ macmini lấy: `infra/secrets/agent-ca.crt`, `agent-ca.key`, `firebase-admin.json`, và các giá trị trong `infra/.env`.

## 2. Tạo resource

New Resource → Git repository → Docker Compose.
- Branch `main`; Base Directory `/`; Docker Compose Location `/docker-compose.coolify.yml`.
- Domain của service **caddy**: `https://itsupport.example.com:8080` (phần `:8080` là cổng trong container, không phải cổng công khai).

## 3. Biến môi trường (Environment Variables)

Bắt buộc (compose báo lỗi nếu thiếu):

| Biến | Giá trị |
|---|---|
| `DB_ADMIN_PASSWORD`, `DB_APP_PASSWORD` | chuỗi ngẫu nhiên **chỉ gồm chữ/số** (chúng nằm trong URL): `openssl rand -hex 24` |
| `APP_PUBLIC_URL` | `https://itsupport.example.com` |
| `CORS_ORIGINS` | cùng giá trị `APP_PUBLIC_URL` |
| `FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_APP_ID` | như `infra/.env` (hai biến `NEXT_PUBLIC_*` phải tick **Build Variable** để vào bản build frontend) |
| `FIREBASE_ADMIN_JSON_B64` | `base64 < firebase-admin.json \| tr -d '\n'` |
| `AGENT_CA_CERT_B64`, `AGENT_CA_KEY_B64` | `base64 < agent-ca.crt \| tr -d '\n'`, tương tự cho `.key` |

Quan trọng khi **chuyển từ macmini**: dùng lại *đúng* `OAUTH_TOKEN_ENC_KEY`, `OAUTH_STATE_SECRET` và CA cũ. Đổi `OAUTH_TOKEN_ENC_KEY` thì mọi token OAuth và mật khẩu repository backup đang lưu **không giải mã được nữa**.

Tuỳ chọn: `AGENT_PUBLIC_URL` (mặc định `${APP_PUBLIC_URL}/api` — **phải kết thúc bằng `/api`**, agent gọi `<url>/devices/...`), `OPENAI_API_KEY`, `SCHOOLSAI_API_URL/KEY`, `MESHCENTRAL_*`, `SMTP_URL`, `MAIL_FROM`, các biến `RESTIC_*` (xem `docs/backup.md`), `DOWNLOADS_DIR` (mặc định `/data/itsupport/downloads`).

## 4. Đưa file agent và restic lên host

Các binary không nằm trong git. Sau mỗi lần `agent/build-release.sh`:

```bash
infra/coolify/push-downloads.sh user@coolify-host
```

Caddy phục vụ file từ thư mục này; script cài (`install-*`) vẫn do frontend phục vụ. Backend đọc manifest qua Caddy nên nút "Cập nhật" thấy bản mới ngay.

## 5. Chuyển dữ liệu và chuyển đổi (cutover)

Agent đã cài lưu sẵn URL lúc đăng ký (`backendUrl`). **Giữ nguyên hostname và đường dẫn `/api`** để chúng tự nối vào Coolify, không phải cài lại.

1. Trên macmini: `docker compose exec db pg_dump -U support -Fc support_agent > support.dump`.
2. Deploy lần đầu trên Coolify, đợi `db` healthy (schema trống được tạo tự động).
3. Nạp dữ liệu (thay `<db-container>` bằng tên container `db` trong Coolify):
   ```bash
   docker cp support.dump <db-container>:/tmp/support.dump
   docker exec <db-container> pg_restore -U support -d support_agent --clean --if-exists --no-owner /tmp/support.dump
   docker exec <db-container> psql -U support -d support_agent -c \
     "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO support_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;"
   ```
   Restart `backend` sau bước này.
4. Chạy `push-downloads.sh`, rồi kiểm tra (mục 6) trên domain tạm hoặc bằng file `hosts`.
5. Đổi DNS/Cloudflare Tunnel sang Coolify. Dừng timer deploy trên macmini (`systemctl --user stop itsupport-deploy.timer`) nhưng **chưa xoá macmini** vài ngày.
6. Đường lui: trỏ DNS về macmini. Dữ liệu ghi trên Coolify trong khoảng đó sẽ không có ở macmini.

## 6. Kiểm tra sau deploy

- `https://<domain>/api/health` trả `{"ok":true,…}`.
- Đăng nhập được; trang Thiết bị thấy các máy chuyển **Đang kết nối** sau ~1 phút.
- `https://<domain>/downloads/agent/windows-amd64/manifest.json` và `…/restic-linux-amd64.bz2` tải được.
- Thử "Gửi email thử" và một lần backup trên máy thử.

## 7. Tự động deploy

Bật **Auto Deploy** hoặc dùng webhook của Coolify. Khác macmini, Coolify không chờ CI: nếu muốn chỉ deploy khi CI xanh, tắt Auto Deploy và gọi webhook deploy từ cuối workflow CI (secret `COOLIFY_WEBHOOK_URL`, `COOLIFY_TOKEN`).

## 8. Backup chính hệ thống này

- Service `backup` dump DB mỗi đêm vào volume `db-backups` (giữ 14 ngày) — cùng ổ với DB nên chưa đủ.
- Cài agent IT Support lên chính máy Coolify và đặt chính sách backup kiểu Linux/Coolify (`docs/backup.md`): thư mục `/data/coolify`, `/data/itsupport` và dump Postgres `container:support:support_agent` (tên container của `db` xem bằng `docker ps`). Dùng repository ở nơi khác (B2/S3), không đặt trên cùng server.
- Mất `OAUTH_TOKEN_ENC_KEY` = mất dữ liệu đã mã hoá: lưu bản sao ngoài Coolify.

## Đã kiểm chứng (cục bộ, không có Docker)

Dựng Postgres thật + chạy đúng script của bản Coolify + backend + frontend + Caddy 2.11:
- `schema.sql` và `02-app-role.sh` khởi tạo DB: 19 bảng, role `support_app` không bypass RLS; đăng nhập bằng mật khẩu scram đúng/sai; RLS trả 0 dòng khi không có tenant.
- `backend-entrypoint.sh` giải mã base64 → file, dựng `DATABASE_URL`, backend lên và `/health` ổn; báo lỗi rõ khi thiếu biến.
- Qua Caddy: `/healthz`, `/api/*`, trang chủ, file tải từ thư mục host, script cài lấy từ frontend; header bảo mật có mặt.
- Header `X-Agent-Cert-Serial` giả: **gửi thẳng vào backend được chấp nhận (200), qua Caddy bị chặn (401)** — đây là lý do bắt buộc giữ Caddy.
- Agent Go thật (`cmd/telemetry`) gửi heartbeat qua Caddy bằng token → máy chuyển `online`. Token sai hoặc của máy khác → 401.
- Scheduler backup, cảnh báo và email SMTP chạy trên DB thật: một thư tóm tắt/workspace, không gửi lặp; secret chỉ được gắn khi agent nhận việc, DB không lưu.
- `pg_dump` của service `backup` chạy được.
- Kiểm tra tĩnh compose: không còn `ports`/`secrets` file, mọi bind mount tồn tại, mọi biến backend của bản macmini vẫn được truyền.

Chưa kiểm chứng được: build image bằng Docker, Traefik/Coolify (cú pháp domain `:8080`, Build Variable, đường dẫn tương đối), Cloudflare Tunnel, và chạy lâu dài.

## Hạn chế đã biết

- Chưa chạy trên Coolify thật; cú pháp domain `:8080`, đường dẫn tương đối và Build Variable có thể cần chỉnh theo phiên bản Coolify.
- Không có mTLS cho agent (chỉ token). Thiết bị bị mất token phải thu hồi và cài lại.
- Giới hạn tốc độ theo IP thấy IP của Caddy (giống macmini), chưa phân biệt từng client.
