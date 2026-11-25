# Web Request

Web để nhân viên các bộ phận gửi và xử lý yêu cầu nội bộ (ticket). Bản demo tháng 01/2027.

## Tính năng

- **Đăng nhập theo tài khoản.** Admin IT tạo tài khoản, chọn vai trò và bộ phận.
- **Vai trò**
  - *User / Admin bộ phận*: tạo yêu cầu, nhận và cập nhật yêu cầu gửi tới bộ phận mình, xem dashboard bộ phận mình.
  - *HoD*: xem mọi yêu cầu và report toàn bộ, ghi chú.
  - *Admin IT*: như HoD, thêm trang phân quyền và cấu hình (tài khoản, quyền theo vai trò, bộ phận, loại yêu cầu, SLA).
- **Mức độ** Normal, Priority, Critical. Mỗi mức có thời hạn nhận và thời hạn xử lý (SLA), Admin IT chỉnh được.
- **Trạng thái** Open → Process (có người nhận) → Follow (xử lý xong, chờ phản hồi) → Done. Pending dùng khi cần thêm thời gian và bắt buộc ghi lý do. Bên gửi có thể mở lại một yêu cầu đang Follow.
- **Tìm kiếm** theo bộ phận, loại, mức độ, trạng thái hoặc từ khoá.
- **Dashboard**: số yêu cầu mới, đang mở, Critical, tỷ lệ đạt SLA, xu hướng theo ngày, theo bộ phận, theo mức độ, các loại nhiều nhất.
- **Cập nhật trực tiếp**: màn hình của mọi người tự cập nhật khi có thay đổi, không cần tải lại trang.
- **Thông báo đẩy lên điện thoại** (web cài được như app):
  - Có yêu cầu mới: báo cả bộ phận xử lý. Nếu là Critical thì báo thêm HoD.
  - Quá thời hạn nhận mà chưa ai nhận: nhắc lại bộ phận một lần (Critical thì nhắc cả HoD).
  - Có người nhận, xử lý xong (Follow), bị mở lại, có ghi chú mới: báo người liên quan.

## Cài lên điện thoại và bật thông báo

Thông báo đẩy chỉ chạy khi web được mở qua **https**.

- **Android (Chrome):** mở web, đăng nhập, bấm **Bật thông báo**. Muốn có biểu tượng app thì bấm menu ⋮ → **Thêm vào màn hình chính**.
- **iPhone (iOS 16.4 trở lên):** mở web bằng Safari, bấm nút **Chia sẻ** → **Thêm vào MH chính**. Mở app từ màn hình chính, đăng nhập, rồi bấm **Bật thông báo**. Trên iPhone, thông báo chỉ hoạt động khi mở web theo cách này.
- **Máy tính:** mở bằng Chrome hoặc Edge rồi bấm **Bật thông báo**.

Mỗi thiết bị cần bật riêng. Trang Phân quyền & cấu hình cho Admin IT biết mỗi người đã bật thông báo trên bao nhiêu thiết bị.

## Cài lên máy chủ (Oracle Cloud Always Free hoặc máy Ubuntu bất kỳ)

Cần một máy Ubuntu 22.04 hoặc 24.04 có địa chỉ IP công khai, đã mở cổng 80 và 443. Kết nối SSH vào máy rồi chạy:

```bash
curl -fsSL https://raw.githubusercontent.com/xuyentvit-web/Web_Request/main/deploy/install.sh | sudo bash
```

Script sẽ:

1. Cài Node.js 22, git và Caddy (Caddy tự cấp chứng chỉ https miễn phí).
2. Tải mã nguồn vào `/opt/web-request`. Dữ liệu được lưu ở `/var/lib/web-request`.
3. Tạo dịch vụ `web-request`, tự chạy lại khi máy khởi động lại.
4. Dùng địa chỉ miễn phí dạng `https://<ip-có-gạch>.sslip.io` nên không cần mua tên miền. Nếu đã có tên miền thì chạy với `DOMAIN=ten-mien.vn` đặt trước `bash`.
5. In ra địa chỉ web và mật khẩu của tài khoản `admin`.

Muốn cập nhật lên bản mới thì chạy lại đúng lệnh trên, dữ liệu được giữ nguyên.

Một số lệnh hữu ích:

```bash
sudo systemctl status web-request        # xem app có đang chạy không
sudo journalctl -u web-request -n 100    # xem log
sudo cp /var/lib/web-request/web-request.db ~/backup-$(date +%F).db   # sao lưu dữ liệu
```

## Chạy trên máy cá nhân để phát triển

Cần Node.js 22.13 trở lên.

```bash
npm install
ADMIN_PASSWORD=admin123 npm start      # mở http://localhost:3000, đăng nhập admin / admin123
npm test
```

Lần chạy đầu, app tạo database ở `data/`, thêm sẵn 6 bộ phận và các loại yêu cầu mẫu, rồi tạo tài khoản `admin`. Nếu không đặt `ADMIN_PASSWORD`, mật khẩu ngẫu nhiên được in ra log. Trên `localhost` thông báo đẩy vẫn chạy mà không cần https.

Biến môi trường:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng web |
| `DATA_DIR` | `./data` | Thư mục chứa database SQLite |
| `ADMIN_PASSWORD` | ngẫu nhiên | Mật khẩu tài khoản `admin`, chỉ dùng ở lần chạy đầu |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Địa chỉ liên hệ gửi kèm thông báo đẩy |

## Cấu trúc

```
server/index.js   API, đăng nhập, phân quyền, luồng trạng thái, nhắc quá hạn
server/db.js      Database SQLite (node:sqlite) và dữ liệu cấu hình ban đầu
server/push.js    Thông báo đẩy (Web Push, khoá VAPID tự tạo và lưu trong database)
public/           Giao diện (HTML, CSS, JS thuần), service worker, manifest để cài như app
deploy/install.sh Script cài lên máy Ubuntu
test/             Kiểm thử API
```

`scripts/icons.js` dựng lại các biểu tượng PNG từ `public/icons/icon.svg`. Script này cần Playwright, chỉ dùng khi đổi biểu tượng.

## Giới hạn hiện tại

- Repo này đang để **public**. Không đưa mật khẩu hay file database lên repo (`data/` đã nằm trong `.gitignore`).
- Thông báo đẩy dùng dịch vụ của trình duyệt (Google, Apple). Điện thoại tắt mạng hoặc bật tiết kiệm pin quá mạnh có thể nhận trễ.
- Database là một file SQLite, đủ cho vài chục người dùng cùng lúc. Nhớ sao lưu định kỳ.
