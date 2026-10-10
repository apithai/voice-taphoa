/**
 * Mã nguồn Google Apps Script (Code.gs) chuẩn cho Google Sheets
 */
export const GOOGLE_APPS_SCRIPT_CODE = `/**
 * ==============================================================================
 * HỆ THỐNG QUẢN LÝ BÁN HÀNG & TỒN KHO BẰNG GIỌNG NÓI - VOICESTOCK
 * File: Code.gs (Dán vào Google Sheets > Tiện ích mở rộng > Apps Script)
 * Chức năng:
 * 1. Nhận POST data từ Web App thời gian thực
 * 2. Tự động khởi tạo & cập nhật 3 Sheet:
 *    - 'LichSuGiaoDich': Nhật ký mọi lần nhập/bán hàng chi tiết
 *    - 'TonKho': Tự động tính Tồn kho = Tổng Nhập - Tổng Bán
 *    - 'HeThongDebug': Nhật ký kiểm tra kết nối & gỡ lỗi (debug) hệ thống
 * 3. Hỗ trợ lệnh kiểm tra kết nối (TEST_CONNECTION / PING)
 * 4. (Tùy chọn) Gửi tin nhắn thông báo về Telegram Bot
 * ==============================================================================
 */

// ==============================================================================
// LƯU Ý QUAN TRỌNG VỀ TELEGRAM (TRÁNH GỬI TRÙNG LẶP):
// Chỉ điền Telegram Bot Token & Chat ID ở MỘT NƠI DUY NHẤT:
// - Cách 1 (Khuyên dùng): Điền Token và Chat ID trong Cài đặt của Web App.
//   Khi đó, HÃY ĐỂ TRỐNG TELEGRAM_CONFIG dưới đây!
// - Cách 2: Điền Token vào TELEGRAM_CONFIG dưới đây thì KHÔNG điền vào Cài đặt Web App.
// TUYỆT ĐỐI KHÔNG ĐIỀN CẢ HAI NƠI để tránh gửi tin nhắn 2 lần cho mỗi giao dịch!
// ==============================================================================
const TELEGRAM_CONFIG = {
  BOT_TOKEN: "", // Để trống nếu đã cấu hình trong Cài đặt Web App
  CHAT_ID: ""    // Để trống nếu đã cấu hình trong Cài đặt Web App
};

/**
 * Xử lý yêu cầu GET: Kiểm tra tình trạng hoạt động và các sheet hiện có
 */
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets().map(s => s.getName());
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "VoiceStock Webhook Google Apps Script đang hoạt động tốt!",
      spreadsheetName: ss.getName(),
      sheets: sheets,
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Xử lý yêu cầu POST từ Web App
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  let ss;
  let rawContent = "";

  try {
    // Khóa tối đa 10 giây tránh xung đột khi nhiều người ghi đồng thời
    lock.waitLock(10000);

    ss = SpreadsheetApp.getActiveSpreadsheet();
    let data;
    
    if (e && e.postData && e.postData.contents) {
      rawContent = e.postData.contents;
      data = JSON.parse(rawContent);
    } else {
      throw new Error("Không tìm thấy dữ liệu POST từ Web App.");
    }

    // 1. Xử lý sự kiện kiểm tra kết nối (TEST / PING)
    if (data.action === "TEST_CONNECTION" || data.action === "PING") {
      logDebug(ss, "KIỂM TRA KẾT NỐI", "THÀNH CÔNG", rawContent, "Nhận tín hiệu test kết nối từ Web App thành công.");
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Kết nối thành công! Đã ghi log kiểm tra vào sheet HeThongDebug.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Xử lý ghi nhận giao dịch nhập / bán hàng
    const tx = data.transaction;
    if (!tx) {
      throw new Error("Dữ liệu giao dịch (transaction) không hợp lệ.");
    }

    // Ghi vào Sheet 'LichSuGiaoDich'
    const historySheet = getOrCreateSheet(ss, "LichSuGiaoDich", [
      "Mã GD", "Thời Gian", "Loại", "Tên Sản Phẩm", "Số Lượng", "Đơn Vị", "Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)", "Câu Thoại Gốc"
    ], ["#1E293B", "#334155"]);

    historySheet.appendRow([
      tx.id || Utilities.getUuid().slice(0, 8),
      tx.formattedTime || Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "HH:mm:ss dd/MM/yyyy"),
      tx.type === "NHAP" ? "NHẬP HÀNG" : "BÁN HÀNG",
      tx.productName,
      tx.quantity,
      tx.unit || "cái",
      tx.unitPrice || 0,
      tx.totalPrice || 0,
      tx.rawTranscript || ""
    ]);

    // Định dạng tiền tệ cho cột Đơn Giá và Thành Tiền
    const lastRowHist = historySheet.getLastRow();
    historySheet.getRange(lastRowHist, 7, 1, 2).setNumberFormat("#,##0 \\"đ\\"");

    // Cập nhật vào Sheet 'TonKho'
    const stockSheet = getOrCreateSheet(ss, "TonKho", [
      "Tên Sản Phẩm", "Đơn Vị", "Tổng Nhập", "Tổng Bán", "Tồn Kho Hiện Tại", "Cập Nhật Cuối"
    ], ["#0F766E", "#115E59"]);

    updateInventory(stockSheet, tx);

    // Với giao dịch BÁN: ghi thêm vào sheet 'BanHangNgay' (lọc được theo ngày) và cập nhật 'Dashboard'
    if (tx.type !== "NHAP") {
      recordSaleDaily(ss, tx);
    }

    // Ghi nhận vào Sheet 'HeThongDebug' để theo dõi kiểm tra hệ thống
    const eventName = tx.type === "NHAP" ? "GIAO DỊCH NHẬP" : "GIAO DỊCH BÁN";
    const noteMsg = "Đã lưu " + (tx.type === "NHAP" ? "nhập" : "bán") + " " + tx.quantity + " " + (tx.unit || "cái") + " " + tx.productName;
    logDebug(ss, eventName, "THÀNH CÔNG", JSON.stringify(tx), noteMsg);

    // (Tùy chọn) Gửi tin nhắn Telegram từ GAS nếu có điền Token
    if (TELEGRAM_CONFIG.BOT_TOKEN && TELEGRAM_CONFIG.CHAT_ID) {
      sendTelegramFromGAS(tx);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Đã lưu giao dịch và cập nhật tồn kho thành công!",
      transactionId: tx.id
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    if (ss) {
      logDebug(ss, "LỖI HỆ THỐNG", "THẤT BẠI", rawContent, error.toString());
    }
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ghi log vào Sheet 'HeThongDebug' để kiểm tra và khắc phục sự cố hệ thống
 */
function logDebug(ss, eventType, status, payloadStr, noteStr) {
  try {
    const debugSheet = getOrCreateSheet(ss, "HeThongDebug", [
      "Thời Gian", "Sự Kiện / Hành Động", "Trạng Thái", "Dữ Liệu Nhận Được (Payload)", "Chi Tiết / Thông Báo Lỗi"
    ], ["#334155", "#475569"]);

    const timeStr = Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "HH:mm:ss dd/MM/yyyy");
    debugSheet.appendRow([
      timeStr,
      eventType,
      status,
      payloadStr ? String(payloadStr).slice(0, 1000) : "",
      noteStr || ""
    ]);

    // Định dạng màu cho cột Trạng Thái
    const lastRow = debugSheet.getLastRow();
    const statusCell = debugSheet.getRange(lastRow, 3);
    if (status === "THÀNH CÔNG") {
      statusCell.setFontColor("#059669").setFontWeight("bold");
    } else {
      statusCell.setFontColor("#DC2626").setFontWeight("bold");
    }
  } catch (err) {
    Logger.log("Không thể ghi log debug: " + err);
  }
}

/**
 * Tìm hoặc tạo mới Sheet nếu chưa tồn tại, có kẻ viền và tô màu tiêu đề
 */
function getOrCreateSheet(ss, sheetName, headers, headerColors) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    
    // Thêm dòng tiêu đề
    sheet.appendRow(headers);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setFontColor("#FFFFFF");
    headerRange.setBackground(headerColors[0]);
    headerRange.setHorizontalAlignment("center");
    headerRange.setVerticalAlignment("middle");
    sheet.setRowHeight(1, 35);
    sheet.setFrozenRows(1);
    
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

/**
 * Cập nhật bảng TonKho: nếu tồn tại thì cộng dồn, chưa thì thêm mới
 */
function updateInventory(sheet, tx) {
  const data = sheet.getDataRange().getValues();
  const prodName = (tx.productName || "").trim().toLowerCase();
  const unit = (tx.unit || "cái").trim().toLowerCase();
  const qty = Number(tx.quantity) || 0;
  const isNhap = tx.type === "NHAP";
  const nowStr = Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "HH:mm:ss dd/MM/yyyy");

  let foundRow = -1;

  for (let i = 1; i < data.length; i++) {
    const rowProd = String(data[i][0]).trim().toLowerCase();
    const rowUnit = String(data[i][1]).trim().toLowerCase();
    if (rowProd === prodName && rowUnit === unit) {
      foundRow = i + 1; // 1-indexed trong Sheets
      break;
    }
  }

  if (foundRow > 0) {
    let curImport = Number(sheet.getRange(foundRow, 3).getValue()) || 0;
    let curExport = Number(sheet.getRange(foundRow, 4).getValue()) || 0;

    if (isNhap) {
      curImport += qty;
    } else {
      curExport += qty;
    }

    const curStock = curImport - curExport;

    sheet.getRange(foundRow, 3).setValue(curImport);
    sheet.getRange(foundRow, 4).setValue(curExport);
    sheet.getRange(foundRow, 5).setValue(curStock);
    sheet.getRange(foundRow, 6).setValue(nowStr);

    const stockCell = sheet.getRange(foundRow, 5);
    if (curStock <= 0) {
      stockCell.setFontColor("#DC2626").setFontWeight("bold");
    } else if (curStock <= 5) {
      stockCell.setFontColor("#D97706").setFontWeight("bold");
    } else {
      stockCell.setFontColor("#059669").setFontWeight("bold");
    }

  } else {
    const importQty = isNhap ? qty : 0;
    const exportQty = isNhap ? 0 : qty;
    const stockQty = importQty - exportQty;

    sheet.appendRow([
      tx.productName,
      tx.unit || "cái",
      importQty,
      exportQty,
      stockQty,
      nowStr
    ]);

    const newRow = sheet.getLastRow();
    const stockCell = sheet.getRange(newRow, 5);
    if (stockQty <= 0) {
      stockCell.setFontColor("#DC2626").setFontWeight("bold");
    } else {
      stockCell.setFontColor("#059669").setFontWeight("bold");
    }
  }
}

/**
 * Ghi mỗi mặt hàng bán vào sheet 'BanHangNgay' (có bộ lọc) và đảm bảo có sheet 'Dashboard'
 */
function recordSaleDaily(ss, tx) {
  const salesSheet = getOrCreateSheet(ss, "BanHangNgay", [
    "Ngày", "Giờ", "Mã Lô", "Mặt Hàng", "Số Lượng", "Đơn Vị", "Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)", "Mã GD"
  ], ["#7C2D12", "#9A3412"]);

  // Bộ lọc trên toàn bộ cột (tạo một lần)
  if (!salesSheet.getFilter()) {
    salesSheet.getRange(1, 1, salesSheet.getMaxRows(), 9).createFilter();
  }

  const now = tx.timestamp ? new Date(tx.timestamp) : new Date();
  const parts = Utilities.formatDate(now, "Asia/Ho_Chi_Minh", "yyyy-MM-dd-HH-mm").split("-");
  // Ngày lưu dạng ngày thuần (00:00) để SUMIFS/QUERY so khớp chính xác
  const dayDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const hm = parts[3] + ":" + parts[4];

  const qty = Number(tx.quantity) || 0;
  const unitPrice = Number(tx.unitPrice) || 0;
  const total = Number(tx.totalPrice) || Math.round(unitPrice * qty);

  salesSheet.appendRow([
    dayDate,
    hm,
    tx.batchId || tx.id || "",
    tx.productName,
    qty,
    tx.unit || "cái",
    unitPrice,
    total,
    tx.id || ""
  ]);

  const last = salesSheet.getLastRow();
  salesSheet.getRange(last, 1).setNumberFormat("dd/MM/yyyy");
  salesSheet.getRange(last, 7, 1, 2).setNumberFormat("#,##0");

  ensureDashboard(ss);
}

/**
 * Tạo sheet 'Dashboard' (nếu chưa có): chọn ngày ở ô B3 để xem doanh thu và chi tiết mặt hàng
 */
function ensureDashboard(ss) {
  if (ss.getSheetByName("Dashboard")) return;

  const dash = ss.insertSheet("Dashboard");

  dash.getRange("A1:F1").merge()
    .setValue("DASHBOARD BÁN HÀNG")
    .setFontSize(16).setFontWeight("bold").setFontColor("#FFFFFF")
    .setBackground("#7C2D12").setHorizontalAlignment("center");
  dash.getRange("A2").setValue("Đổi ô B3 sang ngày khác để xem báo cáo của ngày đó.").setFontColor("#64748B").setFontStyle("italic");

  dash.getRange("A3").setValue("Ngày xem:").setFontWeight("bold");
  dash.getRange("B3").setFormula("=TODAY()").setNumberFormat("dd/MM/yyyy").setBackground("#FEF3C7").setFontWeight("bold");

  dash.getRange("A5:A8").setValues([
    ["Số dòng bán trong ngày"],
    ["Tổng số lượng bán trong ngày"],
    ["Doanh thu trong ngày (VNĐ)"],
    ["Doanh thu toàn bộ (VNĐ)"]
  ]);
  dash.getRange("B5").setFormula('=COUNTIFS(BanHangNgay!A2:A,B3)');
  dash.getRange("B6").setFormula('=SUMIFS(BanHangNgay!E2:E,BanHangNgay!A2:A,B3)');
  dash.getRange("B7").setFormula('=SUMIFS(BanHangNgay!H2:H,BanHangNgay!A2:A,B3)');
  dash.getRange("B8").setFormula('=SUM(BanHangNgay!H2:H)');
  dash.getRange("B5:B8").setFontWeight("bold").setFontColor("#0F766E");
  dash.getRange("B7:B8").setNumberFormat("#,##0");

  dash.getRange("A10").setValue("Chi tiết theo mặt hàng (ngày đã chọn)").setFontWeight("bold");
  dash.getRange("E10").setValue("Doanh thu theo ngày").setFontWeight("bold");
  dash.getRange("A11:C11").setValues([["Mặt hàng", "Số lượng", "Doanh thu (VNĐ)"]]);
  dash.getRange("E11:F11").setValues([["Ngày", "Doanh thu (VNĐ)"]]);
  const hdr = dash.getRange("A11:F11");
  hdr.setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");

  // Mảng động: tự cập nhật khi có dòng bán mới
  dash.getRange("A12").setFormula('=IFERROR(SORT(UNIQUE(FILTER(BanHangNgay!D2:D,BanHangNgay!A2:A=B3,BanHangNgay!D2:D<>"")),1,TRUE),"")');
  dash.getRange("B12").setFormula('=IF(A12="","",ARRAYFORMULA(SUMIFS(BanHangNgay!E2:E,BanHangNgay!D2:D,A12:A,BanHangNgay!A2:A,B3)))');
  dash.getRange("C12").setFormula('=IF(A12="","",ARRAYFORMULA(SUMIFS(BanHangNgay!H2:H,BanHangNgay!D2:D,A12:A,BanHangNgay!A2:A,B3)))');
  dash.getRange("E12").setFormula('=IFERROR(SORT(UNIQUE(FILTER(BanHangNgay!A2:A,BanHangNgay!A2:A<>"")),1,FALSE),"")');
  dash.getRange("F12").setFormula('=IF(E12="","",ARRAYFORMULA(SUMIFS(BanHangNgay!H2:H,BanHangNgay!A2:A,E12:E)))');

  dash.getRange("C12:C1000").setNumberFormat("#,##0");
  dash.getRange("F12:F1000").setNumberFormat("#,##0");
  dash.getRange("E12:E1000").setNumberFormat("dd/MM/yyyy");
  dash.setColumnWidth(1, 240);
  dash.setColumnWidth(2, 120);
  dash.setColumnWidth(3, 150);
  dash.setColumnWidth(5, 120);
  dash.setColumnWidth(6, 150);
  dash.setHiddenGridlines(true);
}

/**
 * Gửi thông báo Telegram trực tiếp từ GAS
 */
function sendTelegramFromGAS(tx) {
  try {
    const isNhap = tx.type === "NHAP";
    const title = isNhap ? "🟢 *[NHẬP KHO THÀNH CÔNG]*" : "🔴 *[BÁN HÀNG THÀNH CÔNG]*";
    const actionText = isNhap ? "Nhập vào" : "Bán ra";
    
    let text = title + "\\n\\n" +
      "📦 *Sản phẩm:* " + tx.productName + "\\n" +
      "🔢 *" + actionText + ":* " + tx.quantity + " " + (tx.unit || "cái") + "\\n";
      
    if (tx.unitPrice) {
      text += "💵 *Đơn giá:* " + tx.unitPrice + " đ\\n";
      text += "💰 *Tổng tiền:* " + (tx.totalPrice || 0) + " đ\\n";
    }
    
    text += "⏰ *Thời gian:* " + (tx.formattedTime || "") + "\\n" +
      "🗣️ *Lệnh thoại:* _\\"" + (tx.rawTranscript || "") + "\\"_";

    const payload = {
      chat_id: TELEGRAM_CONFIG.CHAT_ID,
      text: text,
      parse_mode: "Markdown"
    };

    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_CONFIG.BOT_TOKEN + "/sendMessage", options);
  } catch (err) {
    Logger.log("Lỗi gửi Telegram từ GAS: " + err);
  }
}
`;
