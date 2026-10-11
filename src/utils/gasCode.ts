/**
 * Mã nguồn Google Apps Script (Code.gs) chuẩn cho Google Sheets
 */
export const GOOGLE_APPS_SCRIPT_CODE = `/**
 * ==============================================================================
 * VOICESTOCK - Code.gs (dán vào Google Sheets > Tiện ích mở rộng > Apps Script)
 *
 * Các sheet:
 *  - DanhMuc        : danh mục sản phẩm, giá bán / giá nhập (sửa giá ở đây)
 *  - LichSuGiaoDich : nhật ký MỌI lần nhập / bán (nguồn dữ liệu gốc)
 *  - BanHangNgay    : các dòng BÁN, tính lại từ LichSuGiaoDich mỗi lần ghi
 *  - TonKho         : tính lại từ LichSuGiaoDich mỗi lần ghi
 *  - Dashboard      : báo cáo theo ngày chọn ở ô B3, tự cập nhật
 *  - HeThongDebug   : nhật ký kết nối và lỗi
 *
 * TonKho, BanHangNgay và Dashboard là sheet TỰ ĐỘNG: đừng nhập tay vào đó.
 * Lần đầu, chọn hàm setupAllSheets ở thanh trên rồi bấm Chạy một lần.
 * ==============================================================================
 */

// Chỉ điền Telegram ở MỘT nơi: để trống ở đây nếu đã điền trong Cài đặt Web App.
const TELEGRAM_CONFIG = {
  BOT_TOKEN: "",
  CHAT_ID: ""
};

const TZ = "Asia/Ho_Chi_Minh";
const MAX_ROWS = 5000;

const SHEET = {
  CATALOG: "DanhMuc",
  HISTORY: "LichSuGiaoDich",
  SALES: "BanHangNgay",
  STOCK: "TonKho",
  DASH: "Dashboard",
  DEBUG: "HeThongDebug"
};

const HEADERS = {
  DanhMuc: ["Tên Sản Phẩm", "Đơn Vị", "Giá Bán (VNĐ)", "Giá Nhập (VNĐ)", "Tên Gọi Khác"],
  LichSu: [
    "Mã GD", "Mã Lô", "Ngày", "Thời Gian", "Loại", "Mã SP", "Tên Sản Phẩm",
    "Số Lượng", "Đơn Vị", "Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)", "Lợi Nhuận (VNĐ)", "Câu Thoại Gốc"
  ],
  BanHangNgay: [
    "Ngày", "Giờ", "Mã Lô", "Mã SP", "Mặt Hàng", "Số Lượng", "Đơn Vị",
    "Đơn Giá (VNĐ)", "Thành Tiền (VNĐ)", "Mã GD"
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
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\\s+/g, " ")
    .trim();
}

// "4.500 đ", "4500", 4500 -> 4500
function parseMoney(v) {
  if (typeof v === "number") return v;
  const digits = String(v === null || v === undefined ? "" : v).replace(/[^\\d]/g, "");
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
  const m = String(s || "").match(/(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s+(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  if (!m) return null;
  return new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]));
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
/*  BanHangNgay: tính lại từ LichSuGiaoDich                              */
/* ------------------------------------------------------------------ */

function rebuildSales(ss, histRows) {
  const sales = recreateSheet(ss, SHEET.SALES, HEADERS.BanHangNgay);
  const rows = histRows
    .filter((o) => o["Loại"] === "BÁN HÀNG")
    .map((o) => [
      o["Ngày"] || "",
      String(o["Thời Gian"] || "").slice(0, 5),
      o["Mã Lô"] || "",
      o["Mã SP"] || "",
      o["Tên Sản Phẩm"] || "",
      Number(o["Số Lượng"]) || 0,
      o["Đơn Vị"] || "",
      parseMoney(o["Đơn Giá (VNĐ)"]),
      parseMoney(o["Thành Tiền (VNĐ)"]),
      o["Mã GD"] || ""
    ]);

  if (rows.length > 0) {
    sales.getRange(2, 1, rows.length, HEADERS.BanHangNgay.length).setValues(rows);
    sales.getRange(2, 1, rows.length, 1).setNumberFormat("dd/MM/yyyy");
    sales.getRange(2, 8, rows.length, 2).setNumberFormat("#,##0");
  }
  sales.getRange(1, 1, 1000, HEADERS.BanHangNgay.length).createFilter();
  sales.setColumnWidth(5, 240);
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

  const byKey = {};
  Object.keys(stock).forEach((k) => {
    byKey[k] = stock[k].imp - stock[k].sold;
  });
  return { alerts: alerts, byKey: byKey };
}

/* ------------------------------------------------------------------ */
/*  Dashboard (công thức theo ngày chọn ở B3)                            */
/* ------------------------------------------------------------------ */

function rebuildDashboard(ss, hist, alerts) {
  // Giữ ngày người dùng đã chọn ở B3 (nếu là ô =TODAY() thì giữ công thức)
  let dateValue = "=TODAY()";
  const old = ss.getSheetByName(SHEET.DASH);
  if (old) {
    const cell = old.getRange("B3");
    const f = cell.getFormula();
    if (f) dateValue = f;
    else if (cell.getValue() instanceof Date) dateValue = cell.getValue();
    ss.deleteSheet(old);
  }

  const sh = ss.insertSheet(SHEET.DASH);
  const map = headerMap(hist);
  const rng = (name) => {
    const L = colLetter(map[name]);
    return SHEET.HISTORY + "!$" + L + "$2:$" + L + "$" + MAX_ROWS;
  };
  const DATE = rng("Ngày");
  const TYPE = rng("Loại");
  const NAME = rng("Tên Sản Phẩm");
  const QTY = rng("Số Lượng");
  const TOTAL = rng("Thành Tiền (VNĐ)");
  const PROFIT = rng("Lợi Nhuận (VNĐ)");
  const BAN = "\\"BÁN HÀNG\\"";
  const NHAP = "\\"NHẬP HÀNG\\"";

  sh.getRange("A1:H1").merge()
    .setValue("DASHBOARD BÁN HÀNG")
    .setFontSize(16).setFontWeight("bold").setFontColor("#FFFFFF")
    .setBackground("#7C2D12").setHorizontalAlignment("center");
  sh.getRange("A2")
    .setValue("Đổi ô B3 sang ngày khác để xem báo cáo của ngày đó. Số liệu tự cập nhật sau mỗi lần ghi.")
    .setFontColor("#64748B").setFontStyle("italic");

  sh.getRange("A3").setValue("Ngày xem:").setFontWeight("bold");
  const b3 = sh.getRange("B3");
  if (typeof dateValue === "string") b3.setFormula(dateValue);
  else b3.setValue(dateValue);
  b3.setNumberFormat("dd/MM/yyyy").setBackground("#FEF3C7").setFontWeight("bold");

  const kpi = [
    ["Số lần bán trong ngày", "=COUNTIFS(" + DATE + ",$B$3," + TYPE + "," + BAN + ")"],
    ["Số lượng hàng bán trong ngày", "=SUMIFS(" + QTY + "," + DATE + ",$B$3," + TYPE + "," + BAN + ")"],
    ["Doanh thu trong ngày (VNĐ)", "=SUMIFS(" + TOTAL + "," + DATE + ",$B$3," + TYPE + "," + BAN + ")"],
    ["Lợi nhuận trong ngày (VNĐ)", "=SUMIFS(" + PROFIT + "," + DATE + ",$B$3," + TYPE + "," + BAN + ")"],
    ["Tiền nhập hàng trong ngày (VNĐ)", "=SUMIFS(" + TOTAL + "," + DATE + ",$B$3," + TYPE + "," + NHAP + ")"],
    ["Doanh thu toàn bộ (VNĐ)", "=SUMIFS(" + TOTAL + "," + TYPE + "," + BAN + ")"],
    ["Lợi nhuận toàn bộ (VNĐ)", "=SUMIFS(" + PROFIT + "," + TYPE + "," + BAN + ")"],
    ["Mặt hàng cần chú ý (xem cảnh báo bên phải)", alerts.length]
  ];
  sh.getRange(5, 1, kpi.length, 2).setFormulas(kpi);
  sh.getRange("B5:B12").setNumberFormat("#,##0").setFontWeight("bold").setFontColor("#0F766E");

  // Chi tiết theo mặt hàng của ngày đã chọn
  sh.getRange("A14").setValue("Chi tiết theo mặt hàng (ngày đã chọn)").setFontWeight("bold");
  sh.getRange("A15:D15").setValues([["Mặt hàng", "Số lượng", "Doanh thu (VNĐ)", "Lợi nhuận (VNĐ)"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange("A16").setFormula(
    "=IFERROR(SORT(UNIQUE(FILTER(" + NAME + "," + DATE + "=$B$3," + TYPE + "=" + BAN + "," + NAME + "<>\\"\\"))),\\"\\")"
  );
  sh.getRange("B16").setFormula(
    "=ARRAYFORMULA(IF(A16:A200=\\"\\",\\"\\",SUMIFS(" + QTY + "," + NAME + ",A16:A200," + DATE + ",$B$3," + TYPE + "," + BAN + ")))"
  );
  sh.getRange("C16").setFormula(
    "=ARRAYFORMULA(IF(A16:A200=\\"\\",\\"\\",SUMIFS(" + TOTAL + "," + NAME + ",A16:A200," + DATE + ",$B$3," + TYPE + "," + BAN + ")))"
  );
  sh.getRange("D16").setFormula(
    "=ARRAYFORMULA(IF(A16:A200=\\"\\",\\"\\",SUMIFS(" + PROFIT + "," + NAME + ",A16:A200," + DATE + ",$B$3," + TYPE + "," + BAN + ")))"
  );

  // Doanh thu theo ngày
  sh.getRange("F14").setValue("Doanh thu theo ngày").setFontWeight("bold");
  sh.getRange("F15:H15").setValues([["Ngày", "Doanh thu (VNĐ)", "Lợi nhuận (VNĐ)"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  sh.getRange("F16").setFormula(
    "=IFERROR(SORT(UNIQUE(FILTER(" + DATE + "," + TYPE + "=" + BAN + "," + DATE + "<>\\"\\")),1,FALSE),\\"\\")"
  );
  sh.getRange("G16").setFormula(
    "=ARRAYFORMULA(IF(F16:F200=\\"\\",\\"\\",SUMIFS(" + TOTAL + "," + DATE + ",F16:F200," + TYPE + "," + BAN + ")))"
  );
  sh.getRange("H16").setFormula(
    "=ARRAYFORMULA(IF(F16:F200=\\"\\",\\"\\",SUMIFS(" + PROFIT + "," + DATE + ",F16:F200," + TYPE + "," + BAN + ")))"
  );
  sh.getRange("F16:F200").setNumberFormat("dd/MM/yyyy");
  sh.getRange("C16:D200").setNumberFormat("#,##0");
  sh.getRange("G16:H200").setNumberFormat("#,##0");

  // Cảnh báo tồn kho (cập nhật sau mỗi lần ghi)
  sh.getRange("J14").setValue("Cảnh báo tồn kho").setFontWeight("bold");
  sh.getRange("J15:L15").setValues([["Mặt hàng", "Tồn kho", "Tình trạng"]])
    .setFontWeight("bold").setFontColor("#FFFFFF").setBackground("#334155");
  if (alerts.length > 0) {
    sh.getRange(16, 10, alerts.length, 3).setValues(alerts.map((a) => [a.name, a.stock, a.warn]));
  } else {
    sh.getRange("J16").setValue("Không có mặt hàng cần chú ý.").setFontStyle("italic");
  }

  const widths = { 1: 260, 2: 130, 3: 150, 4: 150, 5: 20, 6: 120, 7: 150, 8: 150, 9: 20, 10: 240, 11: 100, 12: 230 };
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
    "Câu Thoại Gốc": tx.rawTranscript || ""
  });
  formatCells(hist, row, {
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

  const rows = txs.map((tx) => appendTransactionRow(hist, tx, catalog));
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
function syncDerivedSheets(ss, hist, catalog) {
  const histRows = readObjects(hist);
  rebuildSales(ss, histRows);
  const st = rebuildStock(ss, histRows, catalog);
  rebuildDashboard(ss, hist, st.alerts);
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
  return String(Math.round(Number(n) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".") + " đ";
}

function fmtNum(n) {
  return String(Math.round(Number(n) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".");
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

  let s = title + " · " + rows.length + " mặt hàng\\n\\n";

  const table = [padR("Mặt hàng", NAME_W) + " " + padL("SL", 3) + " " + padL("Đơn giá", 8) + " " + padL("Tiền", 9)];
  rows.forEach((r) => {
    table.push(
      padR(r.name, NAME_W) + " " +
      padL(r.qty, 3) + " " +
      padL(r.unitPrice > 0 ? fmtNum(r.unitPrice) : "—", 8) + " " +
      padL(r.total > 0 ? fmtNum(r.total) : "—", 9)
    );
  });
  s += "<pre>" + escHtml(table.join("\\n")) + "</pre>\\n";

  const saleTotal = sales.reduce((acc, r) => acc + (r.total || 0), 0);
  const importTotal = imports.reduce((acc, r) => acc + (r.total || 0), 0);
  if (saleTotal > 0) s += "💰 <b>Tổng tiền bán:</b> " + fmtVnd(saleTotal) + "\\n";
  if (importTotal > 0) s += "📥 <b>Tổng tiền nhập:</b> " + fmtVnd(importTotal) + "\\n";

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
    s += "\\n📊 <b>Tồn kho sau lệnh</b>\\n<pre>" + escHtml(stockRows.join("\\n")) + "</pre>\\n";
  }

  s += "\\n⏰ " + escHtml(rows[0].time) + "\\n";
  s += "🗣️ <i>\\"" + escHtml(raw) + "\\"</i>\\n\\n";
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
`;
