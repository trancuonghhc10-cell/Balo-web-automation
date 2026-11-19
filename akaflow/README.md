# AkaFlow

Web app quản trị Zalo chạy cục bộ, tự chứa dashboard, connector loopback, môi trường Python và bản chạy `zca-js` trong `vendor/zca-js`. Phiên QR được lưu trong `data/zalo_sessions` với quyền chỉ người dùng hệ điều hành hiện tại được đọc.

## Tính năng

- Đăng nhập QR và theo dõi trạng thái nhiều tài khoản.
- Danh sách nhóm và thành viên:
  - Với Trưởng/Phó nhóm trong nhóm ẩn (`lockViewMember = 1`): Đọc danh sách Zalo cấp cho phiên quản trị qua `memberIds` hoặc `memVerList`, rồi lấy hồ sơ theo lô.
  - Với Thành viên thường trong nhóm ẩn: Chỉ ghi nhận thành viên công khai và UID xuất hiện trong dữ liệu tương tác mà phiên được phép nhận.
- Listener realtime tự khởi động cùng phiên Zalo và tích lũy UID từ tin nhắn nhóm, mention, reaction, trạng thái nhập/xem/nhận và sự kiện nhóm.
- Kho quan sát SQLite lưu nguồn bằng chứng, số lần, lần đầu/lần cuối; không lưu nội dung tin nhắn.
- Giao diện tách rõ danh sách được phép xem với UID quan sát theo thời gian, không trình bày dữ liệu tích lũy như danh sách nhóm đầy đủ.
- Không gian Facebook đa hồ sơ: mỗi tài khoản dùng thư mục Chrome riêng trong `data/facebook_profiles`.
- Bản nháp bài cá nhân/nhóm có bước mở trang, sao chép nội dung và xác nhận thủ công; AkaFlow không tự bấm đăng, like hoặc gửi lời mời kết bạn.
- Hiển thị trực quan UID, tên và vai trò từng thành viên, hỗ trợ 1-click lưu vào danh bạ.
- Lưu thành viên được phép xem vào danh bạ với nhãn nguồn nhóm.
- Đồng bộ bạn bè vào danh bạ.
- Danh bạ có nhãn và trạng thái đồng ý.
- Nhập/xuất CSV UTF-8.
- Chiến dịch chạy thử hoặc gửi thật, độ trễ tối thiểu 5 giây, tối đa 100 người/lần.
- Chỉ liên hệ có `consent_status=granted` và có Zalo UID được đưa vào chiến dịch.
- Nhật ký kiểm toán.
- Không có màn hình đăng nhập; ứng dụng bắt buộc chỉ lắng nghe tại `127.0.0.1`/loopback.

## Khởi động

Cần cài sẵn Python 3, Node.js 18 trở lên, npm và curl. Script khởi động sẽ tự tạo môi trường Python, cài các thư viện còn thiếu, rồi dùng dịch vụ kết nối đang chạy ở cổng `8001` hoặc tự khởi động dịch vụ đó nếu chưa có.

```bash
cd /home/pccuong/Downloads/spam/akaflow
./start.sh
```

Mở `http://127.0.0.1:8010`.

Lần chạy đầu tiên cần kết nối Internet để tải thư viện Python và JavaScript. Dữ liệu tài khoản, cookie, cơ sở dữ liệu và log chỉ nằm trong thư mục `data/` cục bộ và không được đưa vào Git.

Có thể đổi cổng bằng `AKAFLOW_PORT`. Vì bản này không có đăng nhập, script sẽ từ chối khởi động nếu `AKAFLOW_HOST` không phải địa chỉ loopback.

## CSV

Các cột được hỗ trợ: `name`, `phone`, `external_id`, `tags`, `consent_status`. Giá trị đồng ý: `unknown`, `granted`, `revoked`.

## Giới hạn

- `zca-js` là adapter không chính thức và có thể thay đổi theo Zalo. Bản tích hợp hiện tại là `2.2.0`.
- AkaFlow không dùng trường theo dõi nội bộ để dựng lại danh sách thành viên bị ẩn.
- Độ phủ quan sát chỉ tăng khi AkaFlow đang chạy và thành viên phát sinh sự kiện mà phiên hiện tại được Zalo gửi hợp lệ.
- Mô-đun Facebook cần Google Chrome trên máy và selector tự động hàng loạt của dự án cũ không được khôi phục.
- Không mở ứng dụng này ra LAN hoặc Internet khi chưa bổ sung lại lớp xác thực.
