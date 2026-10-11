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

## Cập nhật: gom lệnh thoại + Dashboard lọc theo kỳ

- **Gom lệnh thoại** (`src/App.tsx`, `src/utils/nlpParser.ts`): mọi câu nói được cộng dồn vào MỘT giỏ chờ,
  cùng mặt hàng + cùng giá thì cộng số lượng. Nói **"ghi"** để lưu cả giỏ thành 1 đơn (1 Mã Lô, 1 tin Telegram).
  Có nút ✕ để bỏ từng dòng.
- **Apps Script** (`apps-script/Code.gs`, cùng nội dung `src/utils/gasCode.ts`): chỉ còn 5 sheet:
  `DanhMuc`, `LichSuGiaoDich` (có bộ lọc), `TonKho` (có bộ lọc), `Dashboard`, `HeThongDebug`.
  Dashboard chọn **Ngày (B3) · Xem theo Ngày/Tuần/Tháng/Năm/Toàn bộ (B4) · Mặt hàng (B5)** và hiện bảng theo
  mặt hàng, theo ngày, theo tháng. Giao dịch gửi lại (trùng Mã GD) không bị ghi đôi.
