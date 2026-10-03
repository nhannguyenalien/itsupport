# Hướng dẫn sử dụng IT Support

Trang chính: <https://itsupport.schoolsai.work>

## 1. Tạo tài khoản

1. Mở trang chính, chọn **Đăng ký**.
2. Nhập email, mật khẩu và tên công ty/workspace.
3. Mở email Firebase gửi tới và bấm liên kết xác minh.
4. Quay lại trang đăng nhập. Nếu quên mật khẩu, chọn **Quên mật khẩu** để nhận email đặt lại.

Mỗi tài khoản chỉ nhìn thấy dữ liệu của workspace của mình. Tài khoản tạo workspace đầu tiên có vai trò `admin`.

## 2. Thêm máy mới (cách nhanh nhất)

1. Đăng nhập và mở **Thiết bị**.
2. Chọn **+ Thêm máy**, rồi chọn macOS hoặc Windows.
3. Bấm **Sao chép lệnh** và chạy đúng một lệnh trên máy cần hỗ trợ.

Mã cài đặt chỉ dùng được một lần và hết hạn sau 10 phút. Không dùng chung một lệnh cho nhiều máy; với mỗi máy hãy bấm **Tạo lệnh mới**.

### macOS

Mở Terminal bằng tài khoản người dùng sẽ nhận hỗ trợ, dán lệnh được hiển thị trên trang **Thiết bị**, rồi nhấn Enter. Bộ cài tự nhận diện Mac dùng Apple Silicon hay Intel, tự tải agent, enrollment và bật agent khi đăng nhập.

```bash
curl -fsSL https://itsupport.schoolsai.work/downloads/agent/install-macos | /bin/zsh -s -- '<MA_CAI_DAT>'
```

Bộ cài chạy agent bằng LaunchAgent của user hiện tại. Kiểm tra:

```bash
launchctl print gui/$(id -u)/work.schoolsai.itsupport.telemetry
tail -f "$HOME/Library/Logs/SupportAgent/telemetry.log"
```

macOS có thể yêu cầu cấp quyền **Screen Recording** và **Accessibility** cho executor khi dùng điều khiển màn hình.

### Windows

Mở PowerShell bằng **Run as administrator**, dán lệnh được hiển thị trên trang **Thiết bị**, rồi nhấn Enter. Bộ cài tự tải, enrollment và tạo các Windows Service.

Kiểm tra nhanh khi cần hỗ trợ:

```powershell
Get-Service SupportAgent*
Get-Content C:\ProgramData\support-agent\telemetry.log -Tail 50
Get-Content C:\ProgramData\support-agent\daemon.log -Tail 50
```

**Cập nhật agent (Windows, từ bản 0.3.0):** khi có bản mới, trang **Thiết bị** hiện thông báo "Có bản cập nhật agent mới". Bấm **Cập nhật lên x.y.z** ở từng máy hoặc **Cập nhật tất cả**. Máy chỉ cập nhật khi bạn bấm; agent tự kiểm tra chữ ký số của bản phát hành, cài và khởi động lại dịch vụ trong khoảng nửa phút, tự quay về bản cũ nếu bản mới không chạy được. Máy phải đang online.

Máy cài agent trước bản 0.3.0, hoặc macOS/Linux: chạy lại chính lệnh cài đặt (một lần là bật được cập nhật bằng nút bấm trên Windows). Bộ cài giữ nguyên danh tính thiết bị và credential hiện có; chỉ enrollment lại nếu config quá cũ chưa có agent token hoặc credential đã bị thu hồi.

```powershell
$env:SUPPORT_ENROLL_TOKEN='<MA_CAI_DAT>'; irm 'https://itsupport.schoolsai.work/downloads/agent/install-windows' | iex
```

Không cần cài Docker, mở port, cấu hình Cloudflare hay chép file thủ công trên máy khách.

### Nâng cấp agent cũ chưa có token

Bộ cài kiểm tra trường `agentToken` trong config. Nếu thiếu, nó tự sao lưu config thành `config.json.pre-token.bak` và yêu cầu enrollment lại. Sau khi thiết bị mới online, revoke bản ghi thiết bị cũ trong Dashboard để credential/certificate cũ không còn hiệu lực.

Không gửi `agentToken`, enrollment token hoặc toàn bộ `config.json` qua chat/email. Nếu lộ token, revoke thiết bị và enrollment lại.

## 3. Luồng xử lý hỗ trợ

1. Chọn thiết bị đang online.
2. Tạo ticket và mô tả lỗi.
3. Chạy bước AI để chẩn đoán hoặc tạo tool call thủ công.
4. Tác vụ đọc chạy theo policy. Tác vụ thay đổi hệ thống cần technician/admin duyệt nếu policy yêu cầu.
5. Theo dõi kết quả và audit log; chỉ đóng ticket sau khi xác minh thành công.

Admin có thể **Pause actions** để chặn thao tác ghi nhưng vẫn cho phép chẩn đoán đọc, hoặc **Revoke** để ngắt toàn bộ xác thực của agent.

## 4. Xử lý lỗi nhanh

- `401 invalid or revoked agent credential`: config cũ, token sai hoặc thiết bị đã bị revoke; tạo token enrollment mới và chạy lại bộ cài với `--force-re-enroll` (macOS) hoặc `-ForceReEnroll` (Windows).
- Thiết bị offline: kiểm tra telemetry log, DNS/HTTPS tới `itsupport.schoolsai.work`, và đồng hồ hệ thống.
- Enrollment báo token expired/used: tạo token mới; không tái sử dụng token cũ.
- macOS chụp/click không hoạt động: cấp Screen Recording/Accessibility rồi restart các LaunchAgent.

Chi tiết tích hợp nằm tại [API.md](API.md).
