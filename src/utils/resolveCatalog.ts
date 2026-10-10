import { ParsedVoiceResult } from '../types';
import { CatalogItem, matchProduct, normalizeText } from './catalogMatch';

/**
 * Nối kết quả phân tích giọng nói với DANH MỤC sản phẩm.
 *
 * Trạng thái trả về trong parsed.matchStatus:
 *  - 'no_catalog' : chưa có danh mục -> App tiếp tục dùng applyAutoPrice như cũ
 *  - 'matched'    : khớp chắc chắn -> đã đổi sang tên chuẩn (+ giá tự điền nếu có)
 *  - 'ambiguous'  : có nhiều ứng viên -> hiện nút cho người dùng chọn (parsed.candidates)
 *  - 'unknown'    : không có trong danh mục -> giữ nguyên tên đã nói
 */

// Parser gán đơn vị mặc định 'cái' với confidence < 0.9 khi người nói KHÔNG nói đơn vị
const isUnitAssumed = (p: ParsedVoiceResult): boolean => p.unit === 'cái' && p.confidence < 0.9;

/** Áp dụng một sản phẩm của danh mục lên kết quả (tên chuẩn, đơn vị, giá) */
function applyItem(parsed: ParsedVoiceResult, item: CatalogItem): ParsedVoiceResult {
  const out: ParsedVoiceResult = {
    ...parsed,
    matchStatus: 'matched',
    candidates: undefined,
    unitNote: undefined,
  };

  const assumed = isUnitAssumed(parsed);
  const sameUnit = normalizeText(item.unit) === normalizeText(parsed.unit);
  out.productName = item.name;

  let unitOk = true;
  if (assumed || sameUnit) {
    out.unit = item.unit;
  } else {
    // Đã nói rõ đơn vị khác danh mục: giữ đơn vị đã nói, KHÔNG tự điền giá (giá tính theo đơn vị danh mục)
    unitOk = false;
    out.unitNote = `Danh mục tính theo ${item.unit}`;
  }

  const qty = out.quantity || 0;
  if (out.unitPrice && out.unitPrice > 0) {
    // Đã nói giá: giữ nguyên
    if (!out.totalPrice && qty > 0) out.totalPrice = Math.round(out.unitPrice * qty);
    out.priceAuto = false;
  } else if (unitOk) {
    const price = out.action === 'BAN' ? item.sellPrice : item.importPrice;
    if (price > 0) {
      out.unitPrice = price;
      out.totalPrice = qty > 0 ? Math.round(price * qty) : price;
      out.priceAuto = true;
    }
  }
  return out;
}

export function resolveWithCatalog(parsed: ParsedVoiceResult, catalog: CatalogItem[]): ParsedVoiceResult {
  if (!catalog || catalog.length === 0) {
    return { ...parsed, matchStatus: 'no_catalog' };
  }
  if (!parsed.isValid || !parsed.productName) return parsed;

  // (a) Cụm nói TRÙNG KHÍT tên hoặc "Tên gọi khác" của ĐÚNG 1 sản phẩm -> chọn sản phẩm đó
  const key = normalizeText(parsed.productName);
  const exact = catalog.filter((c) =>
    [c.name, ...(c.aliases || [])].some((label) => normalizeText(label) === key)
  );
  if (exact.length === 1) return applyItem(parsed, exact[0]);

  // (b) Khớp gần đúng; nhiều sản phẩm cùng có cụm này thì KHÔNG tự chọn
  const out = matchProduct(parsed.productName, isUnitAssumed(parsed) ? '' : parsed.unit, catalog, 3);
  if (exact.length === 0 && out.confident && out.best) return applyItem(parsed, out.best.item);

  if (out.candidates.length > 0) {
    return { ...parsed, matchStatus: 'ambiguous', candidates: out.candidates.map((c) => c.item) };
  }
  return { ...parsed, matchStatus: 'unknown' };
}

/** Khi người dùng bấm chọn một ứng viên trong danh sách gợi ý */
export function chooseCatalogItem(parsed: ParsedVoiceResult, item: CatalogItem): ParsedVoiceResult {
  return applyItem(parsed, item);
}

/* ------------------------------------------------------------------ */
/*  Đọc file CSV danh mục (xuất từ Google Sheet / Excel)               */
/*  Cột: Tên, Đơn vị, Giá bán, Giá nhập, Tên gọi khác                  */
/* ------------------------------------------------------------------ */
function parseCsvRows(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function parseCatalogCsv(text: string): CatalogItem[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  // Bỏ dòng tiêu đề nếu ô đầu bắt đầu bằng "Tên"
  const start = normalizeText(rows[0][0] || '').startsWith('ten') ? 1 : 0;

  const toNum = (v: string): number => {
    const d = String(v ?? '').replace(/[^\d]/g, '');
    return d ? Number(d) : 0;
  };

  const items: CatalogItem[] = [];
  for (const r of rows.slice(start)) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    items.push({
      name,
      unit: (r[1] || '').trim() || 'cái',
      sellPrice: toNum(r[2]),
      importPrice: toNum(r[3]),
      // Từ cột thứ 5 trở đi đều là tên gọi khác (file dùng dấu ; ngăn cột sẽ tách các cụm ra nhiều cột)
      aliases: r
        .slice(4)
        .join(';')
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return items;
}
