# VoiceStock — Nhập liệu bán hàng và tồn kho bằng giọng nói

Ứng dụng React + TypeScript dành cho cửa hàng nhỏ. Nhận lệnh tiếng Việt bằng Web Speech API, gom nhiều mặt hàng vào một giỏ chờ, cho phép kiểm tra trước khi ghi, quản lý tồn kho/lịch sử, đồng bộ Google Sheets và gửi thông báo Telegram qua máy chủ.

## Trạng thái quan trọng

- Nhánh sửa lỗi: `rewrite/voice-entry-reliability`
- Không được xem lời báo “đã gửi” của trình duyệt là bằng chứng dữ liệu đã ghi vào Google Sheets. Apps Script khi gọi bằng `mode: no-cors` trả về phản hồi opaque; ứng dụng hiện báo rõ cần kiểm tra sheet.
- Telegram chỉ được gọi qua endpoint cùng nguồn `/api/telegram/send`. Không gọi Telegram Bot API trực tiếp từ trình duyệt vì có thể gặp CORS và làm lộ Bot Token.
- Để endpoint Telegram hoạt động, phải chạy ứng dụng bằng `server.ts` (script `npm run dev`) hoặc một máy chủ triển khai có cung cấp endpoint tương đương. Nếu nền tảng chỉ host file tĩnh, endpoint này không tồn tại.
- Chưa xác nhận build/runtime trong phiên sửa này. Hãy chạy các bước kiểm tra bên dưới trước khi dùng dữ liệu thật.

## Chức năng hiện có

- Nhận dạng giọng nói tiếng Việt qua Web Speech API trên trình duyệt tương thích.
- Nhiều mặt hàng trong một câu; dùng “ghi” để chốt giỏ, “đọc” để nghe lại.
- Cộng dồn cùng mặt hàng/đơn vị/hành động/đơn giá trong giỏ chờ.
- Quản lý nhập, bán, giá, tồn kho, lịch sử và danh mục.
- Đồng bộ dữ liệu giữa thiết bị qua API của máy chủ.
- Google Sheets Apps Script: lịch sử giao dịch, tồn kho, dashboard và nhật ký debug.
- Telegram notification thông qua server proxy.

## Chạy trên máy tính

Yêu cầu Node.js bản LTS hiện hành.

```bash
npm install
npm run dev
```

Mở địa chỉ local được Vite/server in ra ở terminal (mặc định cổng 3000).

Kiểm tra kiểu TypeScript:

```bash
npm run lint
```

Tạo bản build frontend:

```bash
npm run build
```

Lưu ý: `npm run build` chỉ kiểm tra/build frontend; để kiểm tra toàn bộ endpoint Telegram và đồng bộ đa thiết bị cần chạy máy chủ và thực hiện thử nghiệm thực tế.

## Cấu hình Google Sheets

1. Tạo một Google Spreadsheet riêng.
2. Mở **Tiện ích mở rộng → Apps Script**.
3. Sao chép nội dung `apps-script/Code.gs` vào trình soạn thảo Apps Script.
4. Chạy hàm `setupAllSheets` một lần và cấp quyền theo hướng dẫn Google.
5. Triển khai dạng **Web app**; chọn thực thi dưới tài khoản của bạn và đặt quyền truy cập phù hợp với cách bạn dùng.
6. Sao chép URL Web App kết thúc bằng `/exec` vào phần Cài đặt của ứng dụng.
7. Gửi một giao dịch thử không quan trọng; xác nhận có đúng một dòng trong `LichSuGiaoDich`, số tồn trong `TonKho` và log trong `HeThongDebug`.

**Chống ghi trùng:** không bấm gửi lại chỉ vì giao diện không đọc được phản hồi. Trước tiên hãy kiểm tra `LichSuGiaoDich`. Nếu Apps Script không xử lý khóa giao dịch idempotent đúng cách, cần sửa backend trước khi dùng thực tế.

## Cấu hình Telegram

- Tạo bot qua tài khoản chính thức `@BotFather`, lấy Bot Token và xác định Chat ID.
- Cấu hình token trong ứng dụng chỉ khi máy chủ do bạn kiểm soát và kết nối HTTPS được bảo vệ. Với triển khai công khai, nên chuyển token sang biến môi trường phía server, không lưu trong LocalStorage.
- Bot phải được mở bằng `/start` hoặc được thêm vào nhóm đích.
- Endpoint `/api/telegram/send` nằm trong `server.ts`; nếu host không chạy server Node.js, cần một backend tương thích thay vì sửa CORS ở frontend.

## Bảo mật và dữ liệu

- Không commit `.env.local`, API key, Telegram Bot Token, thông tin tài khoản ngân hàng hoặc dữ liệu khách hàng.
- Nếu từng công khai Bot Token, hãy thu hồi và tạo token mới qua BotFather.
- Dữ liệu localStorage được lưu trong trình duyệt của thiết bị đó; chỉ đồng bộ đa thiết bị khi endpoint server đang hoạt động.
- Sao lưu Google Sheet và kiểm tra kết quả trước khi sử dụng như sổ kho chính thức.

## Ví dụ lệnh thoại

- “Bán 2 chai nước suối, 3 gói mì rồi ghi”
- “Nhập 5 thùng nước ngọt, 2 lốc sữa, đọc ghi”
- “Bán 1 chai Aquafina” rồi nói “ghi” để chốt giỏ đang chờ

Mức nhận dạng phụ thuộc trình duyệt, micro, tiếng ồn và cách đọc. Luôn kiểm tra giỏ chờ trước khi ghi giao dịch thật.
