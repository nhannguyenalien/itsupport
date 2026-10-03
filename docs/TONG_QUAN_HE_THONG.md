# Tổng quan hệ thống AI IT Support

Tài liệu này dùng cho khách hàng và cho trợ lý hỗ trợ (chatbot) để tư vấn về hệ thống. Hướng dẫn thao tác chi tiết xem [HUONG_DAN_SU_DUNG.md](HUONG_DAN_SU_DUNG.md).

## 1. AI IT Support là gì?

AI IT Support (https://itsupport.schoolsai.work) là dịch vụ hỗ trợ IT bằng AI cho doanh nghiệp. AI chẩn đoán sự cố máy tính, đề xuất cách khắc phục, chờ con người phê duyệt các thao tác thay đổi máy, thực hiện qua agent cài trên máy, rồi tự kiểm tra lại kết quả trước khi coi là đã xử lý xong.

Điểm khác biệt chính:
- **Con người kiểm soát:** AI chỉ tự chạy các thao tác đọc/chẩn đoán. Mọi thao tác thay đổi máy đều cần người có quyền duyệt (trừ khi admin chủ động bật chế độ tự động cho thao tác rủi ro thấp).
- **Không chạy lệnh tùy ý:** agent chỉ thực hiện các công cụ đã được định nghĩa sẵn. Không có chức năng chạy PowerShell/shell tùy ý từ AI.
- **Xác minh bắt buộc:** sau khi sửa, hệ thống tự chạy công cụ kiểm tra (ví dụ khởi động lại dịch vụ in xong thì kiểm tra dịch vụ đang chạy). Chỉ khi kiểm tra đạt thì ticket mới được tính là đã xử lý.
- **Ghi nhật ký đầy đủ:** mọi thao tác, phê duyệt và thay đổi cấu hình đều được ghi audit log.

## 2. Hệ điều hành được hỗ trợ

- **Windows:** agent chạy dưới dạng Windows Service, cài bằng PowerShell (Run as administrator).
- **macOS:** agent chạy bằng LaunchAgent của người dùng, tự nhận diện Apple Silicon/Intel.
- **Linux:** bản x64 và ARM64. Cài/kiểm tra gói phần mềm hỗ trợ Debian, Ubuntu, Proxmox (apt).

Không hỗ trợ điện thoại, máy tính bảng, TV.

## 3. Tài khoản, workspace và vai trò

- Mỗi công ty là một **workspace** riêng. Dữ liệu (máy, ticket, nhật ký) của workspace này không bao giờ nhìn thấy được từ workspace khác.
- Người đăng ký đầu tiên là **admin**.
- Vai trò:
  - **admin:** toàn quyền, gồm tạo mã thêm máy, thu hồi/tạm dừng thiết bị, bật/tắt AI, kết nối dịch vụ.
  - **technician (kỹ thuật viên):** tạo ticket, chạy chẩn đoán, phê duyệt/từ chối thao tác, mở hỗ trợ từ xa.
  - **member (thành viên):** xem thông tin và trao đổi, không phê duyệt thao tác.
- Đăng nhập bằng email (có xác minh email) qua Firebase.

## 4. Thêm máy vào hệ thống

Vào **Thiết bị → + Thêm máy**, chọn hệ điều hành, sao chép lệnh và chạy trên máy cần hỗ trợ. Mã cài đặt chỉ dùng **một lần** và hết hạn sau **10 phút**; mỗi máy cần tạo lệnh mới. Không cần mở port, cài Docker hay cấu hình mạng. Máy gửi tín hiệu định kỳ; quá khoảng 90 giây không có tín hiệu thì được coi là offline.

## 5. Luồng xử lý một sự cố

1. Tạo **ticket** cho một máy và mô tả lỗi (có thể đính kèm 1 tài liệu PDF dạng chữ, DOCX, TXT hoặc MD, tối đa 5 MB).
2. Bấm chạy **chẩn đoán AI**. AI dùng các công cụ đọc: trạng thái dịch vụ, tiến trình, ping, tra DNS, dung lượng ổ đĩa, file tạm, máy in và hàng đợi in, thông tin hệ thống, event log, nhiệt độ phần cứng, trạng thái gói phần mềm (Linux). Trên Windows có thêm: chi tiết máy in (driver, cổng, IP máy in, trạng thái dịch vụ in), hiệu năng máy (CPU, RAM, thời gian chạy, ứng dụng nặng nhất), danh sách ứng dụng tự chạy khi khởi động, và báo cáo thứ gì đang chiếm dung lượng ổ C.
3. AI **đề xuất** cách khắc phục, ví dụ: khởi động lại dịch vụ, tắt tiến trình treo, xóa cache DNS, dọn file tạm, xóa hàng đợi in, cài gói phần mềm (Linux). Trên Windows có thêm: khởi động lại dịch vụ in và xóa lệnh in kẹt, tắt/bật lại ứng dụng tự chạy khi khởi động (giống Task Manager, bật lại được), xóa bộ nhớ đệm tải về của Windows Update.
4. Kỹ thuật viên/admin **duyệt hoặc từ chối** trên trang ticket.
5. Agent thực hiện, hệ thống **tự xác minh**. Đạt thì ticket chuyển sang *đã xử lý*; không đạt thì *khắc phục thất bại*, AI có thể thử cách khác hoặc chuyển cho kỹ thuật viên.

Các trạng thái ticket: mở, đang chẩn đoán, chờ phê duyệt, đang khắc phục, đã xử lý, khắc phục thất bại, đã chuyển kỹ thuật viên, đã đóng.

## 6. Mức rủi ro và phê duyệt

| Mức | Ví dụ | Cách xử lý |
|---|---|---|
| Đọc (read) | xem dịch vụ, ổ đĩa, ping, nhiệt độ, chụp màn hình | Tự chạy, không cần duyệt |
| Thấp (low) | xóa cache DNS, dọn file tạm, xóa hàng đợi in, tắt/bật app khởi động | Cần duyệt; admin có thể bật tự động riêng cho mức này |
| Trung bình (medium) | khởi động lại dịch vụ, khởi động lại dịch vụ in, xóa cache Windows Update | Luôn cần duyệt |
| Cao (high) | tắt tiến trình, cài gói phần mềm, click/gõ phím trên màn hình | Luôn cần duyệt (trừ chế độ điều khiển màn hình tự động, xem mục 7) |

Khi thiết bị bị **tạm dừng thao tác (Pause actions)**, mọi thao tác ghi bị chặn nhưng vẫn chẩn đoán đọc được.

## 7. Điều khiển màn hình bằng AI

Chế độ "Thao tác web/màn hình": AI xem ảnh chụp màn hình và đề xuất click/gõ phím để làm việc thay người dùng (ví dụ điền biểu mẫu theo tài liệu). Mặc định mỗi thao tác đều cần duyệt. Admin có thể bật chế độ tự động; khi đó AI tự thao tác và chỉ dừng lại khi cần người hỗ trợ. Việc gõ số thẻ thanh toán **luôn** cần duyệt. Một phiên tự dừng sau 20 phút hoặc 40 thao tác; có nút **Dừng phiên** bất cứ lúc nào. macOS cần cấp quyền Screen Recording và Accessibility.

## 8. Hỗ trợ từ xa (kỹ thuật viên)

Kỹ thuật viên có thể mở phiên điều khiển từ xa qua MeshCentral từ trang ticket hoặc thiết bị. Người dùng máy phải **bật hỗ trợ từ xa** (công tắc bật/tắt); phiên có thời hạn. Trên Windows/macOS cần người dùng đồng ý; trên Linux không có giao diện thì là phiên dòng lệnh tạm thời.

## 9. Công tắc an toàn

- **Thu hồi thiết bị (Revoke):** ngắt hoàn toàn xác thực của agent trên máy đó.
- **Tạm dừng thao tác thiết bị (Pause):** chặn mọi thao tác thay đổi, vẫn cho chẩn đoán.
- **Tắt AI cho workspace:** AI không thể yêu cầu bất kỳ thao tác nào; kỹ thuật viên vẫn làm thủ công được.

## 10. Bảo mật và quyền riêng tư dữ liệu

- Kết nối HTTPS; mỗi thiết bị có thông tin xác thực riêng, chỉ lưu dạng băm trên máy chủ.
- Danh sách tiến trình chỉ gửi tên, CPU, bộ nhớ, trạng thái — không gửi dòng lệnh (có thể chứa mật khẩu).
- **Chính sách dữ liệu AI** cho từng workspace: Tiêu chuẩn, Ẩn thông tin (che email, IP, tên người dùng trong đường dẫn), Không chụp màn hình, Không gửi log thô.
- Tài liệu đính kèm chỉ được lưu phần chữ trích xuất, không lưu file gốc.
- Không bao giờ gửi mật khẩu, mã cài đặt, agentToken hay file config.json qua chat/email. Nếu lộ, hãy thu hồi thiết bị và cài lại.

## 11. Thống kê

Trang **Thống kê** cho biết: tổng số ticket, số ticket AI tự xử lý, số ticket chuyển kỹ thuật viên, thời gian xử lý trung bình, tỷ lệ phê duyệt, tỷ lệ khắc phục thành công theo từng công cụ, tỷ lệ sự cố lặp lại và chi phí AI ước tính.

## 12. Kết nối dịch vụ quảng cáo

Trang **Kết nối dịch vụ** cho phép kết nối Google Ads, Meta Ads và Google Analytics 4 qua trang cấp quyền chính thức của từng dịch vụ (hệ thống chỉ lưu token đã mã hóa, không thấy mật khẩu). Tính năng này cần cấu hình riêng cho từng triển khai; liên hệ quản trị viên hệ thống nếu cần.

## 13. Trợ lý hỗ trợ (chatbot)

Nút **Trợ lý** ở góc phải màn hình có 2 cấp:
- **Hệ thống (cấp 1):** giải đáp về tính năng và cách dùng — dùng được cả khi chưa đăng nhập. Không xem được dữ liệu riêng của bạn.
- **Tài khoản của tôi (cấp 2):** sau khi đăng nhập, trả lời dựa trên dữ liệu thật của workspace bạn: máy nào online/offline, ticket nào đang mở, chi tiết một ticket, số liệu thống kê. Trợ lý có thể **đề xuất** tạo ticket hoặc chạy chẩn đoán; thao tác chỉ thực hiện khi bạn bấm **Xác nhận**, và vẫn theo đúng quyền vai trò của bạn.

## 14. Câu hỏi thường gặp

**Máy hiện offline thì làm sao?** Kiểm tra máy có mạng, truy cập được itsupport.schoolsai.work qua HTTPS, đồng hồ hệ thống đúng; xem log telemetry (đường dẫn trong hướng dẫn sử dụng). Nếu vẫn lỗi, chạy lại lệnh cài đặt.

**Báo lỗi "401 invalid or revoked agent credential"?** Thiết bị đã bị thu hồi hoặc config cũ. Tạo mã cài đặt mới và chạy lại bộ cài với tùy chọn cài lại (`--force-re-enroll` trên macOS, `-ForceReEnroll` trên Windows).

**Mã cài đặt báo hết hạn/đã dùng?** Mỗi mã chỉ dùng một lần trong 10 phút. Tạo mã mới.

**AI có tự ý sửa máy không?** Không. Thao tác thay đổi máy cần người duyệt, trừ khi admin bật tự động cho thao tác rủi ro thấp hoặc chế độ điều khiển màn hình tự động.

**AI có chạy được mọi lệnh không?** Không. Chỉ các công cụ có sẵn trong hệ thống; không có lệnh shell tùy ý, không gỡ gói, không nâng cấp toàn hệ thống.

**Cập nhật agent thế nào?** Trên Windows, macOS và Linux (agent từ bản 0.3.0): trang **Thiết bị** báo khi có bản mới, bấm **Cập nhật** ở từng máy hoặc **Cập nhật tất cả** — không cần mở terminal, máy chỉ cập nhật khi bạn bấm. Agent chỉ cài bản có chữ ký số hợp lệ của nhà phát hành và tự quay về bản cũ nếu bản mới lỗi. Máy cài bản cũ hơn 0.3.0: chạy lại đúng lệnh cài đặt một lần; danh tính thiết bị được giữ nguyên.

**Máy in không in được thì AI làm gì?** (Windows) AI xem chi tiết máy in và dịch vụ in, ping tới IP máy in, đề xuất xóa lệnh in kẹt hoặc khởi động lại dịch vụ in, rồi in thử một trang để xác nhận. Máy in người dùng tự thêm riêng trong tài khoản của họ (kết nối tới máy chủ in) có thể không hiện với agent.

**Máy chậm thì AI làm gì?** (Windows) AI đo CPU/RAM, tìm ứng dụng nặng nhất, kiểm tra thời gian máy chưa khởi động lại và các ứng dụng tự chạy khi khởi động; có thể đề xuất tắt bớt ứng dụng tự chạy không cần thiết.

**Ổ C đầy thì AI làm gì?** (Windows) AI báo cáo thư mục nào đang chiếm dung lượng (Thùng rác, Downloads, dữ liệu trình duyệt, cache cập nhật…), tự dọn file tạm và cache Windows Update khi được duyệt. Dữ liệu cá nhân (Downloads, Desktop, Thùng rác) người dùng tự xem và xóa.

**Có xem được nhiệt độ CPU không?** Có, công cụ đọc cảm biến phần cứng. Nếu máy không có cảm biến, hệ thống báo rõ là không đọc được.

**Cần người hỗ trợ trực tiếp?** Tạo ticket ở mục **Hỗ trợ**; kỹ thuật viên có thể nhận và mở phiên hỗ trợ từ xa khi bạn bật công tắc cho phép.
