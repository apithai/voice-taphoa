<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/8e2f2189-dd43-48c9-ac53-fba98e42a78a

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Cập nhật: gom lệnh thoại + báo cáo ngày/tháng/năm

- **Gom lệnh thoại** (`src/App.tsx`, `src/utils/nlpParser.ts`): mọi câu nói được cộng dồn vào MỘT giỏ chờ,
  cùng mặt hàng + cùng giá thì cộng số lượng. Nói **"ghi"** để lưu cả giỏ thành 1 đơn (1 Mã Lô, 1 tin Telegram).
  Có nút ✕ để bỏ từng dòng.
- **Apps Script** (`apps-script/Code.gs`, cùng nội dung với `src/utils/gasCode.ts`): dán đè vào Apps Script,
  chạy `setupAllSheets` một lần. Thêm sheet `TongHopNgay`, `TongHopThang`, `TongHopNam`, `TongHopMatHang`;
  `LichSuGiaoDich` có thêm cột `Tháng`, `Năm`; Dashboard chọn Ngày/Tuần/Tháng/Năm/Toàn bộ + lọc mặt hàng;
  giao dịch gửi lại (trùng Mã GD) không bị ghi đôi.
- Sửa `apps-script/Code.gs` rồi tạo lại `gasCode.ts` bằng lệnh trong lịch sử commit (escape `\`, backtick, `${`).
