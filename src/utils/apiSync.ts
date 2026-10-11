import { AppSettings, InventoryItem, ParsedVoiceResult, Transaction } from '../types';

/**
 * Chuẩn hóa chuỗi tiếng Việt: bỏ dấu, chữ thường, gộp khoảng trắng
 */
export function normalizeVietnameseText(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tìm mặt hàng trong kho để lấy giá theo tên và đơn vị
 * - Ưu tiên khớp cả tên và đơn vị.
 * - Nếu không có thì khớp theo tên khi tên đó chỉ xuất hiện đúng 1 lần trong danh sách.
 * - Nếu tên trùng ở nhiều đơn vị mà đơn vị không khớp thì trả về null, KHÔNG đoán bừa.
 */
export function findPriceEntry(
  inventory: InventoryItem[],
  productName: string,
  unit?: string
): InventoryItem | null {
  if (!inventory || !productName) return null;
  const normName = normalizeVietnameseText(productName);
  const normUnit = unit ? normalizeVietnameseText(unit) : '';

  // 1. Ưu tiên khớp cả tên và đơn vị
  if (normUnit) {
    const exactMatch = inventory.find(
      (item) =>
        normalizeVietnameseText(item.productName) === normName &&
        normalizeVietnameseText(item.unit) === normUnit
    );
    if (exactMatch) return exactMatch;
  }

  // 2. Khớp theo tên nếu tên chỉ xuất hiện đúng 1 lần trong danh sách
  const nameMatches = inventory.filter(
    (item) => normalizeVietnameseText(item.productName) === normName
  );

  if (nameMatches.length === 1) {
    return nameMatches[0];
  }

  // Trùng nhiều đơn vị mà không khớp đơn vị -> trả về null
  return null;
}

/**
 * Tự động điền giá cho kết quả nhận diện giọng nói
 * - Nếu parsed.unitPrice đã có (> 0): giữ nguyên, chỉ tính totalPrice nếu thiếu.
 * - Nếu chưa có: tìm bằng findPriceEntry; BAN lấy sellPrice, NHAP lấy importPrice;
 *   nếu giá > 0 gán unitPrice = giá, totalPrice = Math.round(giá * quantity), priceAuto = true.
 * - Nếu không tìm thấy hoặc giá = 0: để nguyên.
 */
export function applyAutoPrice(
  parsed: ParsedVoiceResult,
  inventory: InventoryItem[]
): ParsedVoiceResult {
  const result: ParsedVoiceResult = { ...parsed };
  const qty = result.quantity || 0;

  // Nếu parsed.unitPrice đã có (> 0): giữ nguyên, chỉ tính totalPrice nếu thiếu
  if (result.unitPrice && result.unitPrice > 0) {
    if (!result.totalPrice && qty > 0) {
      result.totalPrice = Math.round(result.unitPrice * qty);
    }
    return result;
  }

  // Nếu chưa có: tìm bằng findPriceEntry
  const item = findPriceEntry(inventory, result.productName, result.unit);
  if (item) {
    const price = result.action === 'BAN' ? (item.sellPrice || 0) : (item.importPrice || 0);
    if (price > 0) {
      result.unitPrice = price;
      result.totalPrice = qty > 0 ? Math.round(price * qty) : price;
      result.priceAuto = true;
      return result;
    }
  }

  return result;
}

/**
 * Định dạng số tiền sang chuẩn VNĐ (vd: 25.000 đ)
 */
export function formatVND(amount?: number | null): string {
  if (amount === undefined || amount === null || isNaN(amount)) return '0 đ';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

/**
 * Định dạng ngày giờ chuẩn Việt Nam (HH:mm:ss DD/MM/YYYY)
 */
export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch {
    return isoString;
  }
}

/** Chuyển một giao dịch thành payload gửi lên Apps Script */
function toSheetTransaction(t: Transaction) {
  return {
    id: t.id,
    batchId: t.batchId || t.id,
    timestamp: t.timestamp,
    formattedTime: t.formattedTime,
    type: t.type, // 'NHAP' | 'BAN'
    typeText: t.type === 'NHAP' ? 'Nhập hàng' : 'Bán hàng',
    productName: t.productName,
    quantity: t.quantity,
    unit: t.unit,
    unitPrice: t.unitPrice || 0,
    totalPrice: t.totalPrice || 0,
    priceAuto: t.priceAuto === true,
    rawTranscript: t.rawTranscript,
  };
}

/**
 * Gửi CẢ MỘT LỆNH (có thể nhiều mặt hàng) tới Apps Script trong MỘT request.
 * Apps Script ghi tất cả các dòng, tính lại tồn kho, rồi gửi MỘT tin Telegram tổng hợp.
 */
export async function syncBatchToGoogleSheets(
  webhookUrl: string,
  transactions: Transaction[],
  telegram?: { botToken: string; chatId: string }
): Promise<{ success: boolean; message: string }> {
  if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
    return { success: false, message: 'URL Webhook Google Sheets không hợp lệ.' };
  }
  if (!transactions.length) {
    return { success: false, message: 'Không có giao dịch để gửi.' };
  }

  const payload = {
    action: 'RECORD_BATCH',
    transactions: transactions.map(toSheetTransaction),
    telegram: telegram?.botToken?.trim() && telegram?.chatId?.trim()
      ? { botToken: telegram.botToken.trim(), chatId: telegram.chatId.trim() }
      : null,
  };

  try {
    // Apps Script thường không trả CORS header cho web app. Gửi text/plain để tránh preflight.
    // Vì no-cors tạo opaque response, tuyệt đối không báo rằng Sheet đã ghi thành công.
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    return {
      success: false,
      message: 'Đã gửi yêu cầu tới Google Sheets nhưng trình duyệt không thể xác minh kết quả. Hãy kiểm tra LichSuGiaoDich trước khi gửi lại; mã giao dịch giúp chống ghi trùng.',
    };
  } catch (error) {
    console.error('Lỗi gửi tới Google Sheets:', error);
    return {
      success: false,
      message: `Không gửi được yêu cầu tới Google Sheets: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Gửi một giao dịch (giữ tương thích với chỗ gửi lại từ tab Lịch sử) */
export async function syncToGoogleSheets(
  webhookUrl: string,
  transaction: Transaction,
  _stockItem?: InventoryItem,
  telegram?: { botToken: string; chatId: string }
): Promise<{ success: boolean; message: string }> {
  return syncBatchToGoogleSheets(webhookUrl, [transaction], telegram);
}

/**
 * Tin Telegram dự phòng do APP gửi khi không đẩy được lên sheet.
 * Cùng bố cục với Apps Script; không có cột tồn kho vì app không biết tồn thật.
 */
export function buildTelegramBatchText(transactions: Transaction[]): string {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const NAME_W = 17;
  const padR = (s: unknown, n: number) => {
    const t = String(s);
    return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
  };
  const padL = (s: unknown, n: number) => {
    const t = String(s);
    return t.length >= n ? t : ' '.repeat(n - t.length) + t;
  };
  const num = (n: number) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  const sales = transactions.filter((t) => t.type === 'BAN');
  const imports = transactions.filter((t) => t.type === 'NHAP');
  const title =
    sales.length && !imports.length
      ? '🔴 <b>BÁN HÀNG</b>'
      : imports.length && !sales.length
        ? '🟢 <b>NHẬP KHO</b>'
        : '🔵 <b>GIAO DỊCH KHO</b>';

  const table = [padR('Mặt hàng', NAME_W) + ' ' + padL('SL', 3) + ' ' + padL('Đơn giá', 8) + ' ' + padL('Tiền', 9)];
  transactions.forEach((t) => {
    table.push(
      padR(t.productName, NAME_W) + ' ' +
      padL(t.quantity, 3) + ' ' +
      padL(t.unitPrice ? num(t.unitPrice) : '—', 8) + ' ' +
      padL(t.totalPrice ? num(t.totalPrice) : '—', 9)
    );
  });

  let text = `${title} · ${transactions.length} mặt hàng\n\n<pre>${esc(table.join('\n'))}</pre>\n`;
  const saleTotal = sales.reduce((a, t) => a + (t.totalPrice || 0), 0);
  const importTotal = imports.reduce((a, t) => a + (t.totalPrice || 0), 0);
  if (saleTotal > 0) text += `💰 <b>Tổng tiền bán:</b> ${num(saleTotal)} đ\n`;
  if (importTotal > 0) text += `📥 <b>Tổng tiền nhập:</b> ${num(importTotal)} đ\n`;
  text += `\n⏰ ${esc(transactions[0].formattedTime)}\n`;
  text += `🗣️ <i>"${esc(transactions[0].rawTranscript)}"</i>\n\n`;
  text += `⚡ <i>VoiceStock · Quản lý tồn kho tức thì</i>`;
  return text;
}

/**
 * Kiểm tra kết nối tới Webhook Google Apps Script (gửi ping và ghi log test vào sheet HeThongDebug)
 */
export async function testGoogleSheetsConnection(
  webhookUrl: string
): Promise<{ success: boolean; message: string; duration?: number }> {
  if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) {
    return {
      success: false,
      message: 'URL Webhook Google Sheets không hợp lệ. Hãy dùng URL Web App kết thúc bằng /exec.',
    };
  }

  const startTime = Date.now();
  const testPayload = {
    action: 'TEST_CONNECTION',
    clientTime: new Date().toISOString(),
    clientTimeFormatted: formatDateTime(new Date().toISOString()),
    note: 'Kiểm tra kết nối từ VoiceStock',
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(testPayload),
    });
    const duration = Date.now() - startTime;
    return {
      success: false,
      duration,
      message: `Đã gửi tín hiệu kiểm tra (${duration}ms), nhưng trình duyệt không cho đọc phản hồi. Hãy mở HeThongDebug trong Google Sheets để xác nhận; đây chưa phải bằng chứng kết nối thành công.`,
    };
  } catch (error) {
    console.error('Lỗi kiểm tra Google Sheets:', error);
    return {
      success: false,
      message: `Không gửi được yêu cầu tới Google Sheets: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Gửi thông báo đến Telegram Bot (Ưu tiên qua máy chủ để tránh bị nhà mạng chặn / CORS, tự động dự phòng gọi trực tiếp)
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ success: boolean; message: string }> {
  if (!botToken?.trim() || !chatId?.trim()) {
    return { success: false, message: 'Chưa cấu hình Telegram Bot Token hoặc Chat ID.' };
  }

  const cleanToken = botToken.trim().replace(/^bot/i, '').trim();
  const cleanChatId = chatId.trim();

  // Chỉ gửi qua server cùng nguồn. Gọi Telegram trực tiếp từ trình duyệt dễ gặp CORS
  // và làm lộ Bot Token trong DevTools/network log.
  try {
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: cleanToken, chatId: cleanChatId, text }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success) {
      return { success: true, message: data.message || 'Telegram đã xác nhận gửi thành công.' };
    }
    return {
      success: false,
      message: data?.message || `Máy chủ Telegram trả về HTTP ${response.status}. Kiểm tra server.ts và cấu hình bot.`,
    };
  } catch (error) {
    console.error('Không gọi được endpoint Telegram cùng nguồn:', error);
    return {
      success: false,
      message: 'Không kết nối được /api/telegram/send. Bản triển khai hiện tại chưa có server proxy hoạt động; không thử gọi Telegram trực tiếp từ trình duyệt vì dễ lỗi CORS và lộ Bot Token.',
    };
  }
}

/**
 * Soạn nội dung tin nhắn giao dịch đẹp mắt cho Telegram (có escape ký tự đặc biệt)
 */
export function buildTelegramTransactionText(
  transaction: Transaction,
  stockItem?: InventoryItem
): string {
  const esc = (v: unknown) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const isNhap = transaction.type === 'NHAP';
  const badge = isNhap ? '🟢 <b>[NHẬP KHO THÀNH CÔNG]</b>' : '🔴 <b>[BÁN HÀNG THÀNH CÔNG]</b>';
  const actionText = isNhap ? 'Nhập vào' : 'Bán ra';

  let priceLine = '';
  if (transaction.unitPrice) {
    priceLine = `\n💵 <b>Đơn giá:</b> ${formatVND(transaction.unitPrice)}`;
    if (transaction.totalPrice) {
      priceLine += `\n💰 <b>Tổng tiền:</b> ${formatVND(transaction.totalPrice)}`;
    }
  }

  const stockLine = stockItem
    ? `\n📊 <b>Tồn kho hiện tại:</b> <code>${stockItem.currentStock} ${esc(stockItem.unit)}</code>`
    : '';

  return `${badge}

📦 <b>Sản phẩm:</b> ${esc(transaction.productName)}
🔢 <b>${actionText}:</b> <b>${transaction.quantity} ${esc(transaction.unit)}</b>${priceLine}${stockLine}
⏰ <b>Thời gian:</b> ${esc(transaction.formattedTime)}
🗣️ <b>Lệnh thoại:</b> <i>"${esc(transaction.rawTranscript)}"</i>

⚡ <i>Hệ thống VoiceStock - Quản lý tồn kho tức thì</i>`;
}

/**
 * Khởi tạo dữ liệu mặc định ban đầu nếu chưa có trong LocalStorage
 */
export const DEFAULT_SETTINGS: AppSettings = {
  googleSheetsWebhook: '',
  telegramBotToken: '',
  telegramChatId: '',
  autoSaveSeconds: 3,
  autoSaveEnabled: true,
  voiceFeedbackEnabled: true,
  speechRate: 1.0,
  beepSoundEnabled: true,
  bankId: '',
  bankAccountNo: '',
  bankAccountName: '',
};

export const INITIAL_INVENTORY: InventoryItem[] = [];

/**
 * Cấu trúc dữ liệu đồng bộ giữa Điện thoại và Máy tính
 */
export interface CloudSyncData {
  inventory?: InventoryItem[];
  history?: Transaction[];
  settings?: Partial<AppSettings>;
  catalog?: any[];
  catalogUpdated?: string;
  updatedAt?: number;
}

/**
 * Tải dữ liệu đồng bộ mới nhất từ server (chia sẻ giữa điện thoại & máy tính)
 */
export async function fetchServerSync(): Promise<{ success: boolean; data?: CloudSyncData; error?: string }> {
  try {
    const res = await fetch('/api/sync', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success && json.data) {
      return { success: true, data: json.data };
    }
    return { success: false, error: 'Không nhận được dữ liệu' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Đẩy dữ liệu cập nhật lên server để các thiết bị khác (điện thoại hoặc máy tính) nhận được
 */
export async function pushServerSync(
  payload: CloudSyncData
): Promise<{ success: boolean; data?: CloudSyncData; error?: string }> {
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.success && json.data) {
      return { success: true, data: json.data };
    }
    return { success: false, error: 'Lỗi cập nhật máy chủ' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
