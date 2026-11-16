# akaAuto Ubuntu - Hệ Thống Tự Động Hóa Native Trên Ubuntu

Hệ thống thay thế hoàn chỉnh cho ứng dụng Windows (.NET akaBiz Auto), được xây dựng để chạy native 100% trên Ubuntu / Linux với giao diện Web Dashboard trực quan và động cơ kết hợp: **Playwright Chromium Persistent Context + Zalo Direct Encrypted API Engine (`zca-js`)**.

---

## 1. Khởi động ứng dụng

Ứng dụng hiện đang chạy sẵn trên cổng `8000`.

Nếu sau này bạn muốn khởi động lại hệ thống:
```bash
cd /home/pccuong/Downloads/spam/auto_app
./start.sh
```

- **Địa chỉ truy cập cục bộ trên máy Ubuntu**: [http://localhost:8000](http://localhost:8000) (hoặc `http://127.0.0.1:8000`)
- **Truy cập từ điện thoại hoặc máy tính khác trong cùng mạng Wi-Fi/LAN**: `http://192.168.2.39:8000`

---

## 2. Kiến trúc động cơ kép (Dual-Engine Architecture)

1. **Direct Encrypted API Engine (`zca-js` Microservice trên cổng `8001`)**:
   - Giao tiếp trực tiếp với Zalo Web Platform API thông qua cơ chế mã hóa AES-128-CBC và chữ ký số `signkey`.
   - **Tốc độ phản hồi tức thời (< 50ms)**: Không tốn RAM render DOM hay giả lập click chuột.
   - **Đăng nhập QR siêu tốc**: Hiển thị mã QR trực tiếp ngay trong Web Dashboard để người dùng quét bằng Zalo trên điện thoại mà không cần mở trình duyệt lớn. Session được mã hóa và lưu vĩnh viễn trong `data/zalo_sessions/acc_{id}.json`.

2. **Playwright Persistent Context Engine**:
   - Quản lý profile Chromium độc lập tại `data/profiles/acc_{id}`.
   - Cung cấp nút "Mở Zalo Web" cho người dùng muốn theo dõi trực quan màn hình Zalo hoặc thao tác thủ công.
   - Hoạt động song song và đóng vai trò fallback tự động khi phiên API yêu cầu tái xác thực.

---

## 3. Các tính năng tự động hóa nâng cao đã tích hợp

### A. Quét toàn bộ thành viên trong nhóm ẩn thành viên (`lockViewMember = 1`)
- **Vấn đề app gốc**: Khi Admin nhóm bật chế độ bảo mật ẩn danh sách thành viên, giao diện Zalo Web / Zalo PC sẽ không hiển thị danh sách thành viên trong mục "Thông tin hội thoại".
- **Giải pháp `zca-js`**:
  - Gửi request mã hóa tới endpoint `/api/group/getmg-v2` trích xuất mảng `memVerList` chứa toàn bộ UID của tất cả các thành viên trong nhóm (kể cả nhóm hàng ngàn người).
  - Tự động chia batch và gọi `/api/social/group/members` để giải mã đầy đủ tên Zalo, ảnh đại diện, chức vụ (Trưởng nhóm / Phó nhóm / Thành viên) và Global ID.
  - Cho phép 1-click **"Lưu vào Danh bạ Khách hàng"** hoặc **"Tạo chiến dịch gửi tin nhắn"** tới toàn bộ thành viên vừa quét được.

### B. Gửi tin nhắn siêu tốc tới từng thành viên nhóm / Danh bạ
- Tích hợp trực tiếp vào module **Chiến dịch** (`run_campaign_task`) với các loại hành động:
  - `zalo_message_group_member`: Gửi tin nhắn, kết bạn tới thành viên Group (kể cả nhóm ẩn).
  - `zalo_message_phone`: Nhắn tin và kết bạn tới danh sách SĐT.
  - `zalo_message_friend`: Gửi tin nhắn chăm sóc bạn bè Zalo.
  - `zalo_message_group`: Gửi tin nhắn thông báo vào các nhóm Zalo.
- Khi gửi tin, hệ thống tự động ưu tiên dispatch qua API `sendMessage` siêu nhanh, sau đó tạm nghỉ ngẫu nhiên (`delay_min` - `delay_max`) để mô phỏng hành vi tự nhiên.

### C. Kiểm tra số điện thoại Zalo hàng loạt (Phone Check)
- Kiểm tra danh sách hàng trăm / hàng ngàn số điện thoại qua `findUser` API.
- Phân loại rõ ràng:
  - **Có Zalo**: Trích xuất Tên Zalo, UID, Avatar, Giới tính.
  - **Chưa đăng ký Zalo**: Nhận diện chính xác để loại bỏ số rác.
- Nút bấm 1-click **"Lưu số Có Zalo vào Danh bạ"** để phân nhóm tệp khách hàng tiềm năng.

### D. Đồng bộ Danh bạ & Nhãn phân loại
- Quét và trích xuất danh sách Bạn bè (`getAllFriends`), Nhãn thẻ màu (`getLabels`) trực tiếp từ tài khoản Zalo.
- Hỗ trợ nhập danh bạ từ tệp Excel (`.xlsx`) hoặc xuất danh bạ ra Excel phục vụ remarketing.
