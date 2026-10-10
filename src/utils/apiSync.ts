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

/**
 * Gửi giao dịch đến Webhook Google Apps Script
 */
export async function syncToGoogleSheets(
  webhookUrl: string,
  transaction: Transaction,
  stockItem?: InventoryItem
): Promise<{ success: boolean; message: string }> {
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return { success: false, message: 'Chưa cấu hình URL Webhook Google Sheets.' };
  }

  const payload = {
    action: 'RECORD_TRANSACTION',
    transaction: {
      id: transaction.id,
      batchId: transaction.batchId || transaction.id,
      timestamp: transaction.timestamp,
      formattedTime: transaction.formattedTime,
      type: transaction.type, // 'NHAP' | 'BAN'
      typeText: transaction.type === 'NHAP' ? 'Nhập hàng' : 'Bán hàng',
      productName: transaction.productName,
      quantity: transaction.quantity,
      unit: transaction.unit,
      unitPrice: transaction.unitPrice || 0,
      totalPrice: transaction.totalPrice || 0,
      priceAuto: transaction.priceAuto === true,
      rawTranscript: transaction.rawTranscript,
    },
    inventory: stockItem
      ? {
          productName: stockItem.productName,
          unit: stockItem.unit,
          totalImport: stockItem.totalImport,
          totalExport: stockItem.totalExport,
          currentStock: stockItem.currentStock,
        }
      : null,
  };

  try {
    // Với Google Apps Script, trình duyệt thường gặp CORS redirect.
    // Dùng mode: 'no-cors' để request được gửi thành công đến Google Apps Script server
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return {
      success: true,
      message: 'Đã gửi dữ liệu đồng bộ tới Google Sheets!',
    };
  } catch (error) {
    console.error('Lỗi gửi tới Google Sheets:', error);
    return {
      success: false,
      message: `Lỗi kết nối Google Sheets: ${(error as Error).message}`,
    };
  }
}

/**
 * Kiểm tra kết nối tới Webhook Google Apps Script (gửi ping và ghi log test vào sheet HeThongDebug)
 */
export async function testGoogleSheetsConnection(
  webhookUrl: string
): Promise<{ success: boolean; message: string; duration?: number }> {
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return {
      success: false,
      message: 'URL Webhook Google Sheets không hợp lệ. URL phải bắt đầu bằng https://script.google.com/macros/s/...',
    };
  }

  const startTime = Date.now();
  const testPayload = {
    action: 'TEST_CONNECTION',
    clientTime: new Date().toISOString(),
    clientTimeFormatted: formatDateTime(new Date().toISOString()),
    note: 'Kiểm tra kết nối và tạo sheet HeThongDebug từ Web App VoiceStock',
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testPayload),
    });

    const duration = Date.now() - startTime;
    return {
      success: true,
      duration,
      message: `Kết nối thành công (${duration}ms)! Đã gửi tín hiệu kiểm tra và ghi nhật ký vào sheet 'HeThongDebug'.`,
    };
  } catch (error) {
    console.error('Lỗi kiểm tra Google Sheets:', error);
    return {
      success: false,
      message: `Không thể kết nối tới Google Sheets: ${(error as Error).message}`,
    };
  }
}

/**
 * Gửi thông báo đến Telegram Bot qua Telegram Bot API
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ success: boolean; message: string }> {
  if (!botToken || !chatId) {
    return { success: false, message: 'Chưa cấu hình Telegram Bot Token hoặc Chat ID.' };
  }

  const cleanToken = botToken.trim();
  const cleanChatId = chatId.trim();
  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cleanChatId,
        text: text,
        parse_mode: 'HTML',
      }),
    });

    const data = await res.json();
    if (data.ok) {
      return { success: true, message: 'Đã gửi thông báo Telegram thành công!' };
    } else {
      return {
        success: false,
        message: `Telegram báo lỗi: ${data.description || 'Không xác định'}`,
      };
    }
  } catch (error) {
    console.error('Lỗi gửi Telegram:', error);
    return {
      success: false,
      message: `Lỗi mạng khi gọi Telegram Bot: ${(error as Error).message}`,
    };
  }
}

/**
 * Soạn nội dung tin nhắn giao dịch đẹp mắt cho Telegram
 */
export function buildTelegramTransactionText(
  transaction: Transaction,
  stockItem?: InventoryItem
): string {
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
    ? `\n📊 <b>Tồn kho hiện tại:</b> <code>${stockItem.currentStock} ${stockItem.unit}</code>`
    : '';

  return `${badge}

📦 <b>Sản phẩm:</b> ${transaction.productName}
🔢 <b>${actionText}:</b> <b>${transaction.quantity} ${transaction.unit}</b>${priceLine}${stockLine}
⏰ <b>Thời gian:</b> ${transaction.formattedTime}
🗣️ <b>Lệnh thoại:</b> <i>"${transaction.rawTranscript}"</i>

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
