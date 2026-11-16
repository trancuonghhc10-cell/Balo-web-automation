# akaAgent Ubuntu — Nền Tảng Tự Động Hóa & Quét Dữ Liệu Zalo Native Trên Linux

Hệ thống được xây dựng và tối ưu hoàn toàn cho môi trường **Ubuntu Linux**, thay thế giải pháp Windows truyền thống (`akaBiz Auto.exe`). Hoạt động theo kiến trúc Protocol Client kết hợp Control Plane Web Dashboard, chạy headless 24/7 trên VPS hoặc máy trạm.

---

## 1. Tính Năng Chính

| Tính Năng | Mô Tả Chi Tiết |
| :--- | :--- |
| **Đăng Nhập Đa Tài Khoản (QR Live)** | Quét mã QR trực tiếp trên giao diện Web Dashboard bằng app Zalo điện thoại. Phiên làm việc (Cookie, IMEI, Session) được mã hóa và lưu tự động vào SQLite, khởi động lại máy không mất phiên. |
| **Quét Dữ Liệu (/data)** | <ul><li>**Bạn bè:** Quét toàn bộ danh bạ (Tên, SĐT, UID, Giới tính, Avatar).</li><li>**Nhóm Zalo:** Quét danh sách nhóm đã tham gia kèm số lượng thành viên.</li><li>**Thành viên nhóm:** Quét toàn bộ thành viên trong nhóm kèm phân quyền (Trưởng nhóm / Phó nhóm / Thành viên).</li></ul> |
| **Kiểm Tra SĐT Có Zalo** | Nhập danh sách SĐT hàng loạt, tự động kiểm tra số nào có Zalo, trích xuất Tên Zalo & UID. Áp dụng cơ chế **giãn cách an toàn ngẫu nhiên (1.2s - 2.5s)** chống rate limit / checkpoint. |
| **Quản Lý Nhóm Data (/data-groups)** | Gom nhóm tệp đối tượng theo nguồn (`scan`, `upload`, `dynamic_filter`), phân loại tag, chuẩn bị cho chiến dịch marketing. |
| **Chiến Dịch Tự Động Gửi Tin** | Lên lịch gửi tin nhắn tự động hỗ trợ **Spintax `{Chào bạn\|Xin chào} [name]`** chống spam, giãn cách ngẫu nhiên từ 5s - 15s giữa các lần gửi. |
| **Xuất File Excel** | Xuất danh bạ bạn bè, thành viên nhóm và kết quả kiểm tra SĐT ra file `.xlsx` chuẩn một click. |
| **Realtime Live Logs** | Toàn bộ tiến trình quét và gửi tin được truyền qua WebSocket về màn hình Live Terminal. |

---

## 2. Cấu Trúc Thư Mục Dự Án

```text
zalo_agent_ubuntu/
├── db.js                 # SQLite database engine (WAL mode)
├── spintax.js            # Engine xử lý Spintax {A|B|C} và biến [name]
├── zaloManager.js        # Core Automation Engine bọc giao thức Zalo Web
├── server.js             # REST API server & WebSocket Server (port 3001)
├── zalo_agent.db         # Cơ sở dữ liệu SQLite lưu trữ dữ liệu
├── package.json          # Dependencies (zca-js, express, ws, better-sqlite3, xlsx)
└── public/               # Web Dashboard Control Plane
    ├── index.html        # Giao diện điều khiển SPA (TailwindCSS + Lucide Icons)
    └── app.js            # Client-side WebSocket & API binding
```

---

## 3. Hướng Dẫn Sử Dụng

### Khởi động Server:
```bash
cd /home/pccuong/Downloads/spam/zalo_agent_ubuntu
node server.js
```
Truy cập giao diện Web tại: **`http://localhost:3001`**

### Quy trình sử dụng:
1. **Kết nối tài khoản:** Bấm nút **"Thêm Tài Khoản (QR)"** trên góc phải màn hình, mở Zalo điện thoại quét mã QR và ấn "Xác nhận đăng nhập".
2. **Quét dữ liệu:** Chọn tài khoản Zalo, chọn hành động *(Bạn bè, Group hoặc Thành viên)* và bấm **"Bắt Đầu Quét Data"**.
3. **Kiểm tra SĐT:** Chuyển sang tab **"Kiểm Tra SĐT Zalo"**, dán danh sách SĐT và bấm **"Bắt Đầu Kiểm Tra"**.
4. **Tạo chiến dịch:** Chuyển sang tab **"Chiến Dịch Gửi Tin"**, bấm **"Tạo Chiến Dịch Mới"**, nhập mẫu tin có Spintax và bấm **"Bắt đầu"**.
