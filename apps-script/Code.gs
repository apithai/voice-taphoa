/**
 * ==============================================================================
 * VOICESTOCK - Code.gs (dán vào Google Sheets > Tiện ích mở rộng > Apps Script)
 *
 * Các sheet:
 *  - DanhMuc        : danh mục sản phẩm, giá bán / giá nhập (sửa giá ở đây)
 *  - LichSuGiaoDich : nhật ký MỌI lần nhập / bán (nguồn dữ liệu gốc, có bộ lọc Ngày/Tháng/Năm/Loại/Mặt hàng)
 *  - TonKho         : tính lại từ LichSuGiaoDich mỗi lần ghi
 *  - Dashboard      : báo cáo theo NGÀY / TUẦN / THÁNG / NĂM + lọc mặt hàng (ô B3, B4, B5)
 *  - HeThongDebug   : nhật ký kết nối và lỗi
 *
 * TonKho và Dashboard là sheet TỰ ĐỘNG: đừng nhập tay vào đó.
 * Lần đầu, chọn hàm setupAllSheets ở thanh trên rồi bấm Chạy một lần.
 * ==============================================================================
 */

// Chỉ điền Telegram ở MỘT nơi: để trống ở đây nếu đã điền trong Cài đặt Web App.
const TELEGRAM_CONFIG = {
  BOT_TOKEN: "",
  CHAT_ID: ""
};

const TZ = "Asia/Ho_Chi_Minh";

const SHEET = {
  CATALOG: "DanhMuc",
  HISTORY: "LichSuGiaoDich",
  STOCK: "TonKho",
  DASH: "Dashboard",
  DEBUG: "HeThongDebug"
};

const HEADERS = {
  DanhMuc: ["Tên Sản Phẩm", "Đơn Vị", "Giá Bán (VNĐ)", "Giá Nhập (VNĐ)", "Tên Gọi Khác"],
  LichSu: [
    "Mã GD", "Mã Lô", "Ngày", "Thời Gian", "Loại", "Mã SP", "Tên Sản Phẩm",
    "Số Lượng", "Đơn Vị", "Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)", "Lợi Nhuận (VNĐ)", "Câu Thoại Gốc",
    "Tháng", "Năm"
  ],
  TonKho: [
    "Mã SP", "Tên Sản Phẩm", "Đơn Vị", "Tổng Nhập", "Tổng Bán",
    "Tồn Kho Hiện Tại", "Giá Trị Tồn (VNĐ)", "Cảnh Báo"
  ],
  HeThongDebug: [
    "Thời Gian", "Sự Kiện / Hành Động", "Trạng Thái", "Dữ Liệu Nhận Được (Payload)", "Chi Tiết / Thông Báo Lỗi"
  ]
};

/* ------------------------------------------------------------------ */
/*  Tiện ích                                                           */
/* ------------------------------------------------------------------ */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Chuẩn hoá để so khớp: bỏ dấu, chữ thường, gộp khoảng trắng
function normKey(s) {
  return String(s === null || s === undefined ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

// "4.500 đ", "4500", 4500 -> 4500
function parseMoney(v) {
  if (typeof v === "number") return v;
  const digits = String(v === null || v === undefined ? "" : v).replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

// Ngày thuần (00:00) theo múi giờ VN, để SUMIFS và so sánh ngày chính xác
function dayOf(d) {
  const p = Utilities.formatDate(d, TZ, "yyyy-MM-dd").split("-");
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function colLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// "00:59:52 10/10/2026" -> Date(2026, 9, 10)
function parseLegacyTime(s) {
  if (s instanceof Date) return null;
  const m = String(s || "").match(/(\d{1,2}):(\d{2})(?::\d{2})?\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]));
}

// Khoá ngày "yyyy-MM-dd" của một dòng lịch sử (cột Ngày là Date, hoặc đọc từ Thời Gian cũ)
function dayKeyOf(o) {
  let d = o["Ngày"];
  if (!(d instanceof Date) || isNaN(d.getTime())) d = parseLegacyTime(o["Thời Gian"]);
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
}

/* ------------------------------------------------------------------ */
/*  Sheet helpers                                                      */
/* ------------------------------------------------------------------ */

function styleHeader(sh, n) {
  sh.getRange(1, 1, 1, n)
    .setFontWeight("bold")
    .setFontColor("#FFFFFF")
    .setBackground("#334155")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(1, 35);
  sh.setFrozenRows(1);
}

// Tên cột -> số thứ tự cột (1-based), dùng tên đầu tiên nếu trùng
function headerMap(sh) {
  const lc = Math.max(sh.getLastColumn(), 1);
  const row = sh.getRange(1, 1, 1, lc).getValues()[0];
  const map = {};
  row.forEach((v, i) => {
    const k = String(v).trim();
    if (k && !(k in map)) map[k] = i + 1;
  });
  return map;
}

// Tạo sheet nếu chưa có; nếu có rồi thì chỉ THÊM cột còn thiếu vào cuối, không xoá dữ liệu cũ
function ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader(sh, headers.length);
    return sh;
  }
  if (sh.getLastRow() === 0 || sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader(sh, headers.length);
    return sh;
  }
  const map = headerMap(sh);
  const missing = headers.filter((h) => !(h in map));
  if (missing.length > 0) {
    const start = sh.getLastColumn() + 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
    styleHeader(sh, sh.getLastColumn());
  }
  return sh;
}

// Sheet nhật ký: nếu tiêu đề không đủ như chuẩn (sheet cũ) thì tạo lại sạch để tránh lệch cột
function ensureLogSheet(ss, name, headers) {
  const sh = ss.getSheetByName(name);
  if (sh) {
    const map = headerMap(sh);
    const ok = headers.every((h) => h in map);
    if (!ok) ss.deleteSheet(sh);
  }
  return ensureSheet(ss, name, headers);
}

// Xoá và tạo lại sheet tự động
function recreateSheet(ss, name, headers) {
  const old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader(sh, headers.length);
  return sh;
}

// Ghi một dòng theo tên cột. Trả về số dòng vừa ghi.
function appendByHeader(sh, obj) {
  const map = headerMap(sh);
  const lc = sh.getLastColumn();
  const row = new Array(lc).fill("");
  Object.keys(obj).forEach((k) => {
    if (map[k]) row[map[k] - 1] = obj[k];
  });
  const target = sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, lc).setValues([row]);
  return target;
}

// Định dạng một ô theo tên cột
function formatCells(sh, rowNum, formats) {
  const map = headerMap(sh);
  Object.keys(formats).forEach((name) => {
    if (map[name]) sh.getRange(rowNum, map[name]).setNumberFormat(formats[name]);
  });
}

// Đọc toàn bộ dòng dữ liệu thành object theo tên cột
function readObjects(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const lc = sh.getLastColumn();
  const head = sh.getRange(1, 1, 1, lc).getValues()[0].map((v) => String(v).trim());
  const data = sh.getRange(2, 1, last - 1, lc).getValues();
  return data.map((row) => {
    const o = {};
    head.forEach((h, i) => {
      if (h && !(h in o)) o[h] = row[i];
    });
    return o;
  });
}

/* ------------------------------------------------------------------ */
/*  Danh mục sản phẩm                                                  */
/* ------------------------------------------------------------------ */

// Đọc DanhMuc. Cột A là MÃ sản phẩm; cụm đầu tiên của "Tên Gọi Khác" là TÊN HIỂN THỊ.
function getCatalog(ss) {
  const sh = ss.getSheetByName(SHEET.CATALOG);
  if (!sh || sh.getLastRow() < 2) return [];

  const values = sh.getDataRange().getValues();
  const head = values[0].map((v) => normKey(v));
  const col = (label, dflt) => {
    const i = head.indexOf(normKey(label));
    return i >= 0 ? i : dflt;
  };
  const iUnit = col("Đơn Vị", 1);
  const iSell = col("Giá Bán (VNĐ)", 2);
  const iImp = col("Giá Nhập (VNĐ)", 3);
  const iAlias = col("Tên Gọi Khác", 4);

  const items = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const code = String(row[0] === null ? "" : row[0]).trim();
    if (!code) continue;
    const aliases = String(row[iAlias] || "")
      .split(/[;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    items.push({
      code: code,
      name: aliases.length > 0 ? aliases[0] : code,
      unit: String(row[iUnit] || "").trim() || "cái",
      sellPrice: parseMoney(row[iSell]),
      importPrice: parseMoney(row[iImp]),
      aliases: aliases
    });
  }
  return items;
}

// Tìm sản phẩm theo mã / tên hiển thị / tên gọi khác. Chỉ trả về khi KHỚP DUY NHẤT.
function findCatalogItem(name, catalog) {
  const key = normKey(name);
  if (!key) return null;

  // 1) Mã hoặc tên hiển thị trùng khít
  const direct = catalog.filter((it) => normKey(it.code) === key || normKey(it.name) === key);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;

  // 2) Tên gọi khác trùng khít
  const byAlias = catalog.filter((it) => it.aliases.some((a) => normKey(a) === key));
  return byAlias.length === 1 ? byAlias[0] : null;
}

/* ------------------------------------------------------------------ */
/*  Lịch sử: bổ sung cột thiếu, sửa dữ liệu cũ                          */
/* ------------------------------------------------------------------ */

function migrateHistory(sh, catalog) {
  const last = sh.getLastRow();
  if (last < 2) return;

  const map = headerMap(sh);
  const lc = sh.getLastColumn();
  const range = sh.getRange(2, 1, last - 1, lc);
  const data = range.getValues();

  let changed = false;
  const idx = (name) => (map[name] ? map[name] - 1 : -1);
  const setIf = (row, name, value) => {
    const i = idx(name);
    if (i >= 0 && row[i] !== value) {
      row[i] = value;
      changed = true;
    }
  };

  data.forEach((row) => {
    // Ngày: lấy từ cột Thời Gian cũ
    if (!row[idx("Ngày")]) {
      const d = parseLegacyTime(row[idx("Thời Gian")]);
      if (d) setIf(row, "Ngày", d);
    }

    // Tháng / Năm: để lọc và gom theo tháng, năm
    {
      const dd = row[idx("Ngày")] instanceof Date ? row[idx("Ngày")] : parseLegacyTime(row[idx("Thời Gian")]);
      if (dd) {
        setIf(row, "Tháng", Utilities.formatDate(dd, TZ, "yyyy-MM"));
        setIf(row, "Năm", Number(Utilities.formatDate(dd, TZ, "yyyy")));
      }
    }

    // Mã SP: dòng cũ chỉ có tên
    if (!row[idx("Mã SP")]) {
      const name = String(row[idx("Tên Sản Phẩm")] || "").trim();
      if (name) {
        const it = findCatalogItem(name, catalog);
        setIf(row, "Mã SP", it ? it.code : name);
      }
    }

    // Số tiền dạng chữ ("4.500 đ") -> số
    ["Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)"].forEach((n) => {
      const i = idx(n);
      if (i >= 0 && typeof row[i] === "string" && row[i] !== "") {
        setIf(row, n, parseMoney(row[i]));
      }
    });

    // Dòng BÁN chưa có giá nhưng sản phẩm đã có trong DanhMuc: bù giá và tính lại
    if (String(row[idx("Loại")]) === "BÁN HÀNG") {
      const qty = Number(row[idx("Số Lượng")]) || 0;
      const it = findCatalogItem(String(row[idx("Mã SP")] || ""), catalog);
      const curPrice = parseMoney(row[idx("Đơn Giá (VNĐ)")]);
      if (it && curPrice === 0 && it.sellPrice > 0) {
        setIf(row, "Đơn Giá (VNĐ)", it.sellPrice);
        setIf(row, "Thành Tiền (VNĐ)", Math.round(it.sellPrice * qty));
        setIf(row, "Lợi Nhuận (VNĐ)", Math.round(it.sellPrice * qty) - qty * it.importPrice);
      } else if (it && row[idx("Lợi Nhuận (VNĐ)")] === "" && curPrice > 0) {
        setIf(row, "Lợi Nhuận (VNĐ)", parseMoney(row[idx("Thành Tiền (VNĐ)")]) - qty * it.importPrice);
      }
    }
  });

  if (changed) range.setValues(data);
}

/* ------------------------------------------------------------------ */
/*  TonKho: tính lại từ LichSuGiaoDich                                  */
/* ------------------------------------------------------------------ */

function rebuildStock(ss, histRows, catalog) {
  const stock = {};
  catalog.forEach((it) => {
    stock[it.code] = { name: it.name, unit: it.unit, imp: 0, sold: 0, price: it.importPrice };
  });

  histRows.forEach((o) => {
    const key = String(o["Mã SP"] || o["Tên Sản Phẩm"] || "").trim();
    if (!key) return;
    if (!stock[key]) {
      stock[key] = {
        name: String(o["Tên Sản Phẩm"] || key),
        unit: String(o["Đơn Vị"] || ""),
        imp: 0,
        sold: 0,
        price: 0
      };
    }
    const q = Number(o["Số Lượng"]) || 0;
    if (o["Loại"] === "NHẬP HÀNG") stock[key].imp += q;
    else if (o["Loại"] === "BÁN HÀNG") stock[key].sold += q;
  });

  const sh = recreateSheet(ss, SHEET.STOCK, HEADERS.TonKho);
  const out = [];
  const alerts = [];

  Object.keys(stock).forEach((key) => {
    const s = stock[key];
    const cur = s.imp - s.sold;
    let warn = "";
    if (s.imp === 0 && s.sold === 0) warn = "";
    else if (cur < 0) warn = "Bán vượt tồn (chưa nhập hàng?)";
    else if (cur === 0) warn = "Hết hàng";
    else if (cur <= 5) warn = "Sắp hết";
    if (warn) alerts.push({ name: s.name, stock: cur, warn: warn });
    out.push([key, s.name, s.unit, s.imp, s.sold, cur, cur > 0 ? cur * s.price : 0, warn]);
  });

  if (out.length > 0) {
    sh.getRange(2, 1, out.length, HEADERS.TonKho.length).setValues(out);
    sh.getRange(2, 4, out.length, 4).setNumberFormat("#,##0");
  }
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(8, 220);
  sh.getRange(1, 1, Math.max(out.length + 1, 2), HEADERS.TonKho.length).createFilter();

  const byKey = {};
  Object.keys(stock).forEach((k) => {
    byKey[k] = stock[k].imp - stock[k].sold;
  });
  return { alerts: alerts, byKey: byKey };
}

/* ------------------------------------------------------------------ */
/*  Dashboard (công thức theo ngày chọn ở B3)                            */
/* ------------------------------------------------------------------ */
/*  Kiểm tra dữ liệu                                                    */
/* ------------------------------------------------------------------ */

// Các mục kiểm tra dữ liệu (tính bằng script nên không bị lỗi công thức)
function dataChecks(histRows, catalog, stockByKey) {
  const codes = {};
  catalog.forEach((it) => { codes[it.code] = it; });
  let notInCatalog = 0;
  let zeroTotal = 0;
  histRows.forEach((o) => {
    const code = String(o["Mã SP"] || "").trim();
    if (code && !codes[code]) notInCatalog += 1;
    if (o["Loại"] === "BÁN HÀNG" && parseMoney(o["Thành Tiền (VNĐ)"]) === 0) zeroTotal += 1;
  });
  const negative = Object.keys(stockByKey).filter((k) => stockByKey[k] < 0).length;
  const noMargin = catalog.filter((it) => it.sellPrice <= it.importPrice).length;
  return [
    ["Giao dịch có Mã SP không có trong Danh mục", notInCatalog],
    ["Giao dịch bán có thành tiền = 0 (thiếu giá)", zeroTotal],
    ["Mặt hàng tồn kho âm", negative],
    ["Mặt hàng có giá bán ≤ giá nhập (lãi 0)", noMargin]
  ];
}

/* ------------------------------------------------------------------ */
/*  Dashboard: chọn NGÀY (B3) + KIỂU XEM (B4) + MẶT HÀNG (B5)             */
/* ------------------------------------------------------------------ */

function rebuildDashboard(ss, hist, alerts, checks, productNames) {
  // Giữ lựa chọn của người dùng ở B3, B4, B5
  let dateValue = "=TODAY()";
  let viewBy = "Ngày";
  let product = "Tất cả";
  const old = ss.getSheetByName(SHEET.DASH);
  if (old) {
    const cell = old.getRange("B3");
    const f = cell.getFormula();
    if (f) dateValue = f;
    else if (cell.getValue() instanceof Date) dateValue = cell.getValue();
    const v4 = String(old.getRange("B4").getValue() || "").trim();
    if (v4) viewBy = v4;
    const v5 = String(old.getRange("B5").getValue() || "").trim();
    if (v5) product = v5;
    ss.deleteSheet(old);
  }

  const sh = ss.insertSheet(SHEET.DASH);
  const map = headerMap(hist);
  // Cả cột (không giới hạn số dòng) nên không bao giờ vượt lưới và không tràn dữ liệu
  const rng = (name) => {
    const L = colLetter(map[name]);
    return SHEET.HISTORY + "!$" + L + ":$" + L;
  };
  const DATE = rng("Ngày");
  const TYPE = rng("Loại");
  const NAME = rng("Tên Sản Phẩm");
  const LOT = rng("Mã Lô");
  const QTY = rng("Số Lượng");
  const TOTAL = rng("Thành Tiền (VNĐ)");
  const PROFIT = rng("Lợi Nhuận (VNĐ)");
  const BAN = "\"BÁN HÀNG\"";
  const NHAP = "\"NHẬP HÀNG\"";
  // Khoảng ngày và bộ lọc mặt hàng (ô phụ ở E3:G5)
  const FROM = "$F$3";
  const TO = "$F$4";
  const NAMECRIT = "$F$5";
  const RANGE = DATE + ",\">=\"&" + FROM + "," + DATE + ",\"<=\"&" + TO;
  const NAMEFILTER = "((" + NAME + "=$B$5)+($B$5=\"Tất cả\")+($B$5=\"\")>0)";

  sh.getRange("A1:L1").merge()
    .setValue("DASHBOARD BÁN HÀNG")
    .setFontSize(16).setFontWeight("bold").setFontColor("#FFFFFF")
    .setBackground("#7C2D12").setHorizontalAlignment("center");
  sh.getRange("A2")
    .setValue("Chọn Ngày (B3), Xem theo Ngày/Tuần/Tháng/Năm/Toàn bộ (B4) và Mặt hàng (B5). Số liệu tự cập nhật sau mỗi lần ghi.")
    .setFontColor("#64748B").setFontStyle("italic");

  sh.getRange("A3").setValue("Ngày xem:").setFontWeight("bold");
  const b3 = sh.getRange("B3");
  if (typeof dateValue === "string") b3.setFormula(dateValue);
  else b3.setValue(dateValue);
  b3.setNumberFormat("dd/MM/yyyy").setBackground("#FEF3C7").setFontWeight("bold");

  sh.getRange("A4").setValue("Xem theo:").setFontWeight("bold");
  sh.getRange("B4").setValue(viewBy).setBackground("#FEF3C7").setFontWeight("bold")
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(["Ngày", "Tuần", "Tháng", "Năm", "Toàn bộ"], true).setAllowInvalid(false).build());

  sh.getRange("A5").setValue("Mặt hàng:").setFontWeight("bold");
  const listNames = ["Tất cả"].concat(productNames.slice(0, 480));
  if (listNames.indexOf(product) < 0) product = "Tất cả";
  sh.getRange("B5").setValue(product).setBackground("#FEF3C7").setFontWeight("bold")
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(listNames, true).setAllowInvalid(false).build());

  // Ô phụ: từ ngày / đến ngày / bộ lọc (tự tính từ B3, B4, B5)
  sh.getRange("E3:E5").setValues([["Từ ngày:"], ["Đến ngày:"], ["Lọc tên:"]]).setFontColor("#64748B");
  sh.getRange("F3").setFormula(
    "=IF($B$4=\"Ngày\",$B$3,IF($B$4=\"Tuần\",$B$3-WEEKDAY($B$3,2)+1,IF($B$4=\"Tháng\",DATE(YEAR($B$3),MONTH($B$3),1),IF($B$4=\"Năm\",DATE(YEAR($B$3),1,1),DATE(2000,1,1)))))"
  );
  sh.getRange("F4").setFormula(
    "=IF($B$4=\"Ngày\",$B$3,IF($B$4=\"Tuần\",$B$3-WEEKDAY($B$3,2)+7,IF($B$4=\"Tháng\",EOMONTH($B$3,0),IF($B$4=\"Năm\",DATE(YEAR($B$3),12,31),DATE(2100,12,31)))))"
  );
  sh.getRange("F5").setFormula("=IF(OR($B$5=\"\",$B$5=\"Tất cả\"),\"*\",$B$5)");
  sh.getRange("F3:F4").setNumberFormat("dd/MM/yyyy").setFontColor("#64748B");
  sh.getRange("F5").setFontColor("#64748B");

  const kpi = [
    ["Số đơn trong kỳ (mỗi lần nói \"ghi\" = 1 đơn)",
      "=IFERROR(COUNTA(UNIQUE(FILTER(" + LOT + "," + TYPE + "=" + BAN + "," + DATE + ">=" + FROM + "," + DATE + "<=" + TO + "," + NAMEFILTER + "))),0)"],
    ["Số dòng bán trong kỳ", "=COUNTIFS(" + RANGE + "," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + ")"],
    ["Số lượng hàng bán trong kỳ", "=SUMIFS(" + QTY + "," + RANGE + "," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + ")"],
    ["Doanh thu trong kỳ (VNĐ)", "=SUMIFS(" + TOTAL + "," + RANGE + "," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + ")"],
    ["Lợi nhuận trong kỳ (VNĐ)", "=SUMIFS(" + PROFIT + "," + RANGE + "," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + ")"],
    ["Tiền nhập hàng trong kỳ (VNĐ)", "=SUMIFS(" + TOTAL + "," + RANGE + "," + TYPE + "," + NHAP + "," + NAME + "," + NAMECRIT + ")"],
    ["Doanh thu toàn bộ (VNĐ)", "=SUMIFS(" + TOTAL + "," + TYPE + "," + BAN + ")"],
    ["Lợi nhuận toàn bộ (VNĐ)", "=SUMIFS(" + PROFIT + "," + TYPE + "," + BAN + ")"],
    ["Mặt hàng cần chú ý (xem cảnh báo bên phải)", alerts.length]
  ];
  // Labels and formulas are written separately; B15 is a numeric alert count, not a formula.
  sh.getRange(7, 1, kpi.length, 1).setValues(kpi.map((row) => [row[0]]));
  sh.getRange(7, 2, 8, 1).setFormulas(kpi.slice(0, 8).map((row) => [row[1]]));
  sh.getRange("B15").setValue(alerts.length);
  sh.getRange("B7:B15").setNumberFormat("#,##0").setFontWeight("bold").setFontColor("#0F766E");

  // Chi tiết theo mặt hàng trong kỳ đã chọn
  sh.getRange("A17").setValue("Chi tiết theo mặt hàng (kỳ đã chọn)").setFontWeight("bold");
  sh.getRange("A18:D18").setValues([["Mặt hàng", "Số lượng", "Doanh thu (VNĐ)", "Lợi nhuận (VNĐ)"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange("A19").setFormula(
    "=IFERROR(SORT(UNIQUE(FILTER(" + NAME + "," + TYPE + "=" + BAN + "," + DATE + ">=" + FROM + "," + DATE + "<=" + TO + "," + NAME + "<>\"\"," + NAMEFILTER + "))),\"\")"
  );
  const perName = (SUM) => "=ARRAYFORMULA(IF(A19:A200=\"\",\"\",SUMIFS(" + SUM + "," + NAME + ",A19:A200," + RANGE + "," + TYPE + "," + BAN + ")))";
  sh.getRange("B19").setFormula(perName(QTY));
  sh.getRange("C19").setFormula(perName(TOTAL));
  sh.getRange("D19").setFormula(perName(PROFIT));
  sh.getRange("B19:D200").setNumberFormat("#,##0");

  // Doanh thu theo ngày trong kỳ đã chọn
  sh.getRange("F17").setValue("Doanh thu theo ngày (kỳ đã chọn)").setFontWeight("bold");
  sh.getRange("F18:H18").setValues([["Ngày", "Doanh thu (VNĐ)", "Lợi nhuận (VNĐ)"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange("F19").setFormula(
    "=IFERROR(SORT(UNIQUE(FILTER(" + DATE + "," + TYPE + "=" + BAN + "," + DATE + ">=" + FROM + "," + DATE + "<=" + TO + "," + DATE + "<>\"\"," + NAMEFILTER + ")),1,FALSE),\"\")"
  );
  const perDay = (SUM) => "=ARRAYFORMULA(IF(F19:F200=\"\",\"\",SUMIFS(" + SUM + "," + DATE + ",F19:F200," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + ")))";
  sh.getRange("G19").setFormula(perDay(TOTAL));
  sh.getRange("H19").setFormula(perDay(PROFIT));
  sh.getRange("F19:F200").setNumberFormat("dd/MM/yyyy");
  sh.getRange("G19:H200").setNumberFormat("#,##0");

  // Doanh thu theo tháng trong kỳ đã chọn
  sh.getRange("J17").setValue("Doanh thu theo tháng (kỳ đã chọn)").setFontWeight("bold");
  sh.getRange("J18:L18").setValues([["Tháng", "Doanh thu (VNĐ)", "Lợi nhuận (VNĐ)"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange("J19").setFormula(
    "=IFERROR(SORT(UNIQUE(ARRAYFORMULA(EOMONTH(FILTER(" + DATE + "," + TYPE + "=" + BAN + "," + DATE + ">=" + FROM + "," + DATE + "<=" + TO + "," + DATE + "<>\"\"," + NAMEFILTER + "),-1)+1)),1,FALSE),\"\")"
  );
  const perMonth = (SUM) => "=ARRAYFORMULA(IF(J19:J200=\"\",\"\",IFERROR(SUMIFS(" + SUM + "," + DATE + ",\">=\"&J19:J200," + DATE + ",\"<=\"&EOMONTH(J19:J200,0)," + TYPE + "," + BAN + "," + NAME + "," + NAMECRIT + "),\"\")))";
  sh.getRange("K19").setFormula(perMonth(TOTAL));
  sh.getRange("L19").setFormula(perMonth(PROFIT));
  sh.getRange("J19:J200").setNumberFormat("MM/yyyy");
  sh.getRange("K19:L200").setNumberFormat("#,##0");

  // Cảnh báo tồn kho (cập nhật sau mỗi lần ghi)
  sh.getRange("N17").setValue("Cảnh báo tồn kho").setFontWeight("bold");
  sh.getRange("N18:P18").setValues([["Mặt hàng", "Tồn kho", "Tình trạng"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  if (alerts.length > 0) {
    sh.getRange(19, 14, alerts.length, 3).setValues(alerts.map((a) => [a.name, a.stock, a.warn]));
    sh.getRange(19, 16, alerts.length, 1).setFontColor("#B91C1C");
  } else {
    sh.getRange("N19").setValue("Không có mặt hàng cần chú ý.").setFontStyle("italic");
  }

  // Kiểm tra dữ liệu
  sh.getRange("R17").setValue("Kiểm tra dữ liệu").setFontWeight("bold");
  sh.getRange("R18:S18").setValues([["Hạng mục", "Số dòng"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange(19, 18, checks.length, 2).setValues(checks);
  checks.forEach((c, i) => {
    if (c[1] > 0) sh.getRange(19 + i, 19).setFontColor("#B91C1C").setFontWeight("bold");
  });

  const widths = { 1: 300, 2: 130, 3: 150, 4: 150, 5: 90, 6: 120, 7: 150, 8: 150, 9: 20, 10: 110, 11: 150, 12: 150, 13: 20, 14: 240, 15: 100, 16: 230, 17: 20, 18: 330, 19: 90 };
  Object.keys(widths).forEach((c) => sh.setColumnWidth(Number(c), widths[c]));
  sh.setHiddenGridlines(true);
}

/* ------------------------------------------------------------------ */
/*  Web App: GET                                                       */
/* ------------------------------------------------------------------ */

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const action = e && e.parameter && e.parameter.action ? e.parameter.action : "";

    // App tải danh mục giá từ sheet DanhMuc
    if (action === "catalog") {
      const items = getCatalog(ss);
      return jsonOut({
        status: "success",
        count: items.length,
        items: items.map((it) => ({
          code: it.code,
          name: it.name,
          unit: it.unit,
          sellPrice: it.sellPrice,
          importPrice: it.importPrice,
          aliases: it.aliases
        })),
        timestamp: new Date().toISOString()
      });
    }

    return jsonOut({
      status: "success",
      message: "VoiceStock Webhook Google Apps Script đang hoạt động tốt!",
      spreadsheetName: ss.getName(),
      sheets: ss.getSheets().map((s) => s.getName()),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return jsonOut({ status: "error", message: err.toString() });
  }
}

/* ------------------------------------------------------------------ */
/*  Web App: POST                                                      */
/* ------------------------------------------------------------------ */

function doPost(e) {
  const lock = LockService.getScriptLock();
  let ss = null;
  let rawContent = "";

  try {
    lock.waitLock(15000);
    ss = SpreadsheetApp.getActiveSpreadsheet();

    if (!(e && e.postData && e.postData.contents)) {
      throw new Error("Không tìm thấy dữ liệu POST từ Web App.");
    }
    rawContent = e.postData.contents;
    const data = JSON.parse(rawContent);

    if (data.action === "TEST_CONNECTION" || data.action === "PING") {
      logDebug(ss, "KIỂM TRA KẾT NỐI", "THÀNH CÔNG", rawContent, "Nhận tín hiệu test kết nối từ Web App thành công.");
      return jsonOut({
        status: "success",
        message: "Kết nối thành công! Đã ghi log kiểm tra vào sheet HeThongDebug.",
        timestamp: new Date().toISOString()
      });
    }

    const txs = Array.isArray(data.transactions)
      ? data.transactions
      : data.transaction ? [data.transaction] : [];
    if (txs.length === 0) throw new Error("Dữ liệu giao dịch (transaction) không hợp lệ.");

    saveBatch(ss, txs, rawContent, data.telegram || null);

    return jsonOut({
      status: "success",
      message: "Đã lưu " + txs.length + " giao dịch và cập nhật các sheet thành công!",
      transactionIds: txs.map((t) => t.id)
    });
  } catch (error) {
    if (ss) logDebug(ss, "LỖI HỆ THỐNG", "THẤT BẠI", rawContent, error.toString());
    return jsonOut({ status: "error", message: error.toString() });
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      // bỏ qua
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Ghi một lệnh (có thể nhiều mặt hàng) và đồng bộ tất cả các sheet     */
/* ------------------------------------------------------------------ */

// Ghi một dòng vào LichSuGiaoDich, trả về thông tin để dựng tin nhắn
function appendTransactionRow(hist, tx, catalog) {
  const isBan = tx.type !== "NHAP";
  const when = tx.timestamp ? new Date(tx.timestamp) : new Date();
  const d = isNaN(when.getTime()) ? new Date() : when;
  const fullTime = tx.formattedTime || Utilities.formatDate(d, TZ, "HH:mm:ss dd/MM/yyyy");

  const qty = Number(tx.quantity) || 0;
  const rawName = String(tx.productName || "").trim();
  const item = findCatalogItem(rawName, catalog);

  const key = item ? item.code : rawName;
  const displayName = item ? item.name : rawName;
  const unit = String(tx.unit || (item ? item.unit : "") || "cái");

  // Giá: ưu tiên giá app gửi lên; nếu không có thì lấy từ DanhMuc
  let unitPrice = Number(tx.unitPrice) || 0;
  if (!unitPrice && item) unitPrice = isBan ? item.sellPrice : item.importPrice;
  const total = Number(tx.totalPrice) || Math.round(unitPrice * qty);

  let profit = "";
  if (isBan && item && unitPrice > 0) profit = total - qty * item.importPrice;

  const row = appendByHeader(hist, {
    "Mã GD": tx.id || "",
    "Mã Lô": tx.batchId || tx.id || "",
    "Ngày": dayOf(d),
    "Thời Gian": fullTime,
    "Loại": isBan ? "BÁN HÀNG" : "NHẬP HÀNG",
    "Mã SP": key,
    "Tên Sản Phẩm": displayName,
    "Số Lượng": qty,
    "Đơn Vị": unit,
    "Đơn Giá (VNĐ)": unitPrice,
    "Thành Tiền (VNĐ)": total,
    "Lợi Nhuận (VNĐ)": profit,
    "Câu Thoại Gốc": tx.rawTranscript || "",
    "Tháng": Utilities.formatDate(d, TZ, "yyyy-MM"),
    "Năm": Number(Utilities.formatDate(d, TZ, "yyyy"))
  });
  formatCells(hist, row, {
    "Tháng": "@",
    "Ngày": "dd/MM/yyyy",
    "Đơn Giá (VNĐ)": "#,##0",
    "Thành Tiền (VNĐ)": "#,##0",
    "Lợi Nhuận (VNĐ)": "#,##0"
  });

  return {
    isBan: isBan,
    key: key,
    name: displayName,
    qty: qty,
    unit: unit,
    unitPrice: unitPrice,
    total: total,
    inCatalog: !!item,
    time: fullTime,
    raw: tx.rawTranscript || "",
    id: tx.id || ""
  };
}

// Ghi cả một lệnh: mọi mặt hàng trong lệnh được ghi trước, rồi tính lại các sheet một lần,
// rồi gửi MỘT tin Telegram tổng hợp cho cả lệnh.
function saveBatch(ss, txs, rawContent, tgCfg) {
  ensureSheet(ss, SHEET.CATALOG, HEADERS.DanhMuc);
  const hist = ensureSheet(ss, SHEET.HISTORY, HEADERS.LichSu);
  ensureLogSheet(ss, SHEET.DEBUG, HEADERS.HeThongDebug);

  const catalog = getCatalog(ss);
  migrateHistory(hist, catalog);

  // Bỏ giao dịch đã có (cùng Mã GD) để gửi lại không bị ghi trùng
  const existingIds = {};
  readObjects(hist).forEach((o) => { if (o["Mã GD"]) existingIds[String(o["Mã GD"])] = true; });
  const fresh = txs.filter((tx) => !(tx.id && existingIds[String(tx.id)]));
  if (fresh.length === 0) return;

  const rows = fresh.map((tx) => appendTransactionRow(hist, tx, catalog));
  const stockByKey = syncDerivedSheets(ss, hist, catalog);

  rows.forEach((r) => {
    let note = (r.isBan ? "Đã lưu bán " : "Đã lưu nhập ") + r.qty + " " + r.unit + " " + r.name;
    if (!r.inCatalog) note += " (chưa có trong DanhMuc nên chưa tính được giá)";
    else if (r.isBan && r.unitPrice === 0) note += " (giá 0 trong DanhMuc)";
    logDebug(ss, r.isBan ? "GIAO DỊCH BÁN" : "GIAO DỊCH NHẬP", "THÀNH CÔNG", rawContent, note);
  });

  const tgToken = TELEGRAM_CONFIG.BOT_TOKEN || (tgCfg && tgCfg.botToken) || "";
  const tgChat = TELEGRAM_CONFIG.CHAT_ID || (tgCfg && tgCfg.chatId) || "";
  if (tgToken && tgChat && rows.length > 0) {
    sendTelegramHtml(tgToken, tgChat, buildTelegramBatchHtml(rows, stockByKey, rows[0].raw));
  }
}

// Tính lại BanHangNgay, TonKho, Dashboard từ LichSuGiaoDich. Trả về tồn kho theo khoá sản phẩm.
function ensureHistoryFilter(hist) {
  if (!hist.getFilter()) {
    hist.getRange(1, 1, Math.max(hist.getMaxRows(), 2), Math.max(hist.getLastColumn(), 1)).createFilter();
  }
}

// Xoá các sheet tự động cũ không còn dùng (gộp vào Dashboard + bộ lọc của LichSuGiaoDich)
function removeOldSheets(ss) {
  ["BanHangNgay", "TongHopNgay", "TongHopThang", "TongHopNam", "TongHopMatHang"].forEach((n) => {
    const old = ss.getSheetByName(n);
    if (old && ss.getSheets().length > 1) ss.deleteSheet(old);
  });
}

function syncDerivedSheets(ss, hist, catalog) {
  ensureHistoryFilter(hist);
  const histRows = readObjects(hist);
  const st = rebuildStock(ss, histRows, catalog);
  const names = [];
  const seen = {};
  histRows.forEach((o) => {
    const n = String(o["Tên Sản Phẩm"] || "").trim();
    if (n && !seen[n]) { seen[n] = true; names.push(n); }
  });
  names.sort();
  rebuildDashboard(ss, hist, st.alerts, dataChecks(histRows, catalog, st.byKey), names);
  return st.byKey;
}

/* ------------------------------------------------------------------ */
/*  Chạy một lần từ trình soạn thảo: tạo đủ sheet và báo cáo              */
/* ------------------------------------------------------------------ */

function setupAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SHEET.CATALOG, HEADERS.DanhMuc);
  const hist = ensureSheet(ss, SHEET.HISTORY, HEADERS.LichSu);
  ensureLogSheet(ss, SHEET.DEBUG, HEADERS.HeThongDebug);
  const catalog = getCatalog(ss);
  migrateHistory(hist, catalog);
  removeOldSheets(ss);
  syncDerivedSheets(ss, hist, catalog);
  Logger.log("Đã tạo/cập nhật các sheet. Danh mục: " + catalog.length + " sản phẩm.");
}

/* ------------------------------------------------------------------ */
/*  Nhật ký debug                                                      */
/* ------------------------------------------------------------------ */

function logDebug(ss, eventType, status, payloadStr, noteStr) {
  try {
    const sh = ensureLogSheet(ss, SHEET.DEBUG, HEADERS.HeThongDebug);
    const timeStr = Utilities.formatDate(new Date(), TZ, "HH:mm:ss dd/MM/yyyy");
    const row = appendByHeader(sh, {
      "Thời Gian": timeStr,
      "Sự Kiện / Hành Động": eventType,
      "Trạng Thái": status,
      "Dữ Liệu Nhận Được (Payload)": payloadStr ? String(payloadStr).slice(0, 1000) : "",
      "Chi Tiết / Thông Báo Lỗi": noteStr || ""
    });
    const statusCell = sh.getRange(row, headerMap(sh)["Trạng Thái"]);
    if (status === "THÀNH CÔNG") {
      statusCell.setFontColor("#059669").setFontWeight("bold");
    } else {
      statusCell.setFontColor("#DC2626").setFontWeight("bold");
    }
  } catch (err) {
    Logger.log("Không thể ghi log debug: " + err);
  }
}

/* ------------------------------------------------------------------ */
/*  Telegram: MỘT tin cho cả lệnh, mỗi mặt hàng một dòng, tồn kho từ sheet */
/* ------------------------------------------------------------------ */

function escHtml(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 25000 -> "25.000 đ"
function fmtVnd(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " đ";
}

function fmtNum(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function padR(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + " ".repeat(n - t.length);
}

function padL(s, n) {
  const t = String(s);
  return t.length >= n ? t : " ".repeat(n - t.length) + t;
}

// Một tin cho cả lệnh: bảng mặt hàng, bảng tồn kho sau lệnh, tổng tiền.
// Cột canh đều trong <pre> (tổng độ rộng 40 ký tự để vừa màn hình điện thoại).
function buildTelegramBatchHtml(rows, stockByKey, raw) {
  const NAME_W = 17;
  const sales = rows.filter((r) => r.isBan);
  const imports = rows.filter((r) => !r.isBan);

  let title;
  if (sales.length > 0 && imports.length === 0) title = "🔴 <b>BÁN HÀNG</b>";
  else if (imports.length > 0 && sales.length === 0) title = "🟢 <b>NHẬP KHO</b>";
  else title = "🔵 <b>GIAO DỊCH KHO</b>";

  let s = title + " · " + rows.length + " mặt hàng\n\n";

  const table = [padR("Mặt hàng", NAME_W) + " " + padL("SL", 3) + " " + padL("Đơn giá", 8) + " " + padL("Tiền", 9)];
  rows.forEach((r) => {
    table.push(
      padR(r.name, NAME_W) + " " +
      padL(r.qty, 3) + " " +
      padL(r.unitPrice > 0 ? fmtNum(r.unitPrice) : "—", 8) + " " +
      padL(r.total > 0 ? fmtNum(r.total) : "—", 9)
    );
  });
  s += "<pre>" + escHtml(table.join("\n")) + "</pre>\n";

  const saleTotal = sales.reduce((acc, r) => acc + (r.total || 0), 0);
  const importTotal = imports.reduce((acc, r) => acc + (r.total || 0), 0);
  if (saleTotal > 0) s += "💰 <b>Tổng tiền bán:</b> " + fmtVnd(saleTotal) + "\n";
  if (importTotal > 0) s += "📥 <b>Tổng tiền nhập:</b> " + fmtVnd(importTotal) + "\n";

  const seen = {};
  const stockRows = [];
  rows.forEach((r) => {
    if (seen[r.key] || !Object.prototype.hasOwnProperty.call(stockByKey, r.key)) return;
    seen[r.key] = true;
    const cur = stockByKey[r.key];
    let status;
    if (!r.inCatalog) status = "chưa có DM";
    else if (cur < 0) status = "ÂM";
    else if (cur === 0) status = "hết";
    else if (cur <= 5) status = "sắp hết";
    else status = "đủ";
    stockRows.push(padR(r.name, NAME_W) + " " + padL(cur + " " + r.unit, 11) + "  " + status);
  });
  if (stockRows.length > 0) {
    s += "\n📊 <b>Tồn kho sau lệnh</b>\n<pre>" + escHtml(stockRows.join("\n")) + "</pre>\n";
  }

  s += "\n⏰ " + escHtml(rows[0].time) + "\n";
  s += "🗣️ <i>\"" + escHtml(raw) + "\"</i>\n\n";
  s += "⚡ <i>VoiceStock · Quản lý tồn kho tức thì</i>";
  return s;
}

function sendTelegramHtml(token, chatId, text) {
  try {
    const res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log("Telegram trả về lỗi: " + res.getContentText());
    }
  } catch (err) {
    Logger.log("Lỗi gửi Telegram từ GAS: " + err);
  }
}
