import { ParsedVoiceResult, TransactionType } from '../types';

/* ------------------------------------------------------------------ */
/*  Tiện ích regex: \b của JS KHÔNG hiểu chữ có dấu tiếng Việt         */
/*  (ví dụ "gạo" bị cắt mất "ạ"), nên dùng lookaround theo Unicode.    */
/* ------------------------------------------------------------------ */
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function phraseRegex(phrase: string, flags = 'iu'): RegExp {
  const body = escapeRegex(phrase).replace(/\s+/g, '\\s+');
  return new RegExp(`${START}${body}${END}`, flags);
}

function removeSpan(s: string, index: number, length: number): string {
  return `${s.slice(0, index)} ${s.slice(index + length)}`;
}

/* ------------------------------------------------------------------ */
/*  Đơn vị tính (chuẩn hóa về một tên duy nhất)                        */
/* ------------------------------------------------------------------ */
const UNIT_MAP: Record<string, string> = {
  thùng: 'thùng', gói: 'gói', hộp: 'hộp', chai: 'chai', lon: 'lon', cái: 'cái',
  kg: 'kg', kí: 'kg', ký: 'kg', gam: 'gam', gram: 'gam', chiếc: 'cái', lốc: 'lốc',
  vỉ: 'vỉ', túi: 'túi', bao: 'bao', bịch: 'túi', cuộn: 'cuộn', bó: 'bó', ly: 'ly',
  cốc: 'cốc', bình: 'bình', tấm: 'tấm', bộ: 'bộ', đôi: 'đôi', cặp: 'cặp', con: 'con',
  cây: 'cây', lọ: 'lọ', hũ: 'hũ', thanh: 'thanh', mét: 'mét', m: 'mét', lít: 'lít', lit: 'lít',
};

/* ------------------------------------------------------------------ */
/*  Số tiếng Việt dạng chữ: "hai mươi lăm", "một trăm hai mươi",       */
/*  "hai chục", "nửa"...                                               */
/* ------------------------------------------------------------------ */
const DIGIT_WORDS: Record<string, number> = {
  một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5,
  sáu: 6, bảy: 7, bẩy: 7, tám: 8, chín: 9,
};

interface NumberMatch {
  value: number;
  length: number; // số token đã dùng
}

function parseNumberAt(tokens: string[], i: number): NumberMatch | null {
  const t = tokens[i];

  // Chữ số: 1.000 (hàng nghìn), 10, 1,5, 0.5
  if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) {
    return { value: parseInt(t.replace(/\./g, ''), 10), length: 1 };
  }
  if (/^\d+(?:[.,]\d+)?$/.test(t)) {
    const v = parseFloat(t.replace(',', '.'));
    return v > 0 ? { value: v, length: 1 } : null;
  }

  if (t === 'nửa') return { value: 0.5, length: 1 };
  if (t === 'một' && tokens[i + 1] === 'nửa') return { value: 0.5, length: 2 };

  // Số dạng chữ (< 1000)
  let j = i;
  let hundreds = 0;
  let tens = 0;
  let pending: number | null = null;
  let consumed = false;

  while (j < tokens.length) {
    const w = tokens[j];

    if (w in DIGIT_WORDS) {
      const d = DIGIT_WORDS[w];
      if (pending === null) {
        pending = d;
      } else if (tens === 0 && pending >= 2 && (w === 'mốt' || w === 'lăm')) {
        // "hai mốt" = 21, "hai lăm" = 25
        tens = pending;
        pending = d;
      } else {
        break;
      }
    } else if (w === 'mười') {
      if (pending !== null || tens > 0) break;
      tens = 1;
    } else if (w === 'mươi') {
      if (pending === null || tens > 0) break;
      tens = pending;
      pending = null;
    } else if (w === 'chục') {
      if (tens > 0) break;
      tens = pending ?? 1;
      pending = null;
    } else if (w === 'trăm') {
      if (hundreds > 0 || tens > 0) break;
      hundreds = pending ?? 1;
      pending = null;
    } else if ((w === 'lẻ' || w === 'linh') && hundreds > 0 && tokens[j + 1] in DIGIT_WORDS) {
      // "một trăm lẻ năm" = 105
    } else {
      break;
    }

    j++;
    consumed = true;
  }

  if (!consumed) return null;
  const value = hundreds * 100 + tens * 10 + (pending ?? 0);
  return value > 0 ? { value, length: j - i } : null;
}

/* ------------------------------------------------------------------ */
/*  Giá tiền                                                           */
/* ------------------------------------------------------------------ */
function extractPrice(text: string): { price: number | null; index: number; length: number } {
  const none = { price: null, index: -1, length: 0 };

  // 1.5 triệu, 2 triệu, 2 củ
  const million = text.match(
    new RegExp(`${START}(?:giá\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:triệu|củ|tr)${END}`, 'iu')
  );
  if (million && million.index !== undefined) {
    const val = parseFloat(million[1].replace(',', '.'));
    return { price: Math.round(val * 1_000_000), index: million.index, length: million[0].length };
  }

  // 25k, 25 k, 25 nghìn, 25 ngàn  (k phải đứng riêng, không dính vào "kg")
  const thousand = text.match(
    new RegExp(`${START}(?:giá\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:k|nghìn|ngàn)${END}`, 'iu')
  );
  if (thousand && thousand.index !== undefined) {
    const val = parseFloat(thousand[1].replace(',', '.'));
    return { price: Math.round(val * 1000), index: thousand.index, length: thousand[0].length };
  }

  // giá 25000, giá 25.000đ, đơn giá: 25,000
  const full = text.match(
    new RegExp(
      `${START}(?:đơn\\s+giá|giá|tiền)\\s*[:=]?\\s*(\\d{1,3}(?:[.,]\\d{3})+|\\d+)\\s*(?:vnđ|vnd|đồng|dong|đ)?${END}`,
      'iu'
    )
  );
  if (full && full.index !== undefined) {
    const val = parseInt(full[1].replace(/[.,]/g, ''), 10);
    if (!isNaN(val) && val > 0) {
      return { price: val, index: full.index, length: full[0].length };
    }
  }

  return none;
}

/* ------------------------------------------------------------------ */
/*  Hành động nhập / bán                                               */
/* ------------------------------------------------------------------ */
const byLengthDesc = (arr: string[]) => [...arr].sort((a, b) => b.length - a.length);

const NHAP_KEYWORDS = byLengthDesc([
  'nhập kho', 'nhập hàng', 'nhập vào', 'nhập thêm', 'mua vào', 'mua về', 'về hàng', 'thêm kho', 'nhập',
]);
const BAN_KEYWORDS = byLengthDesc([
  'bán cho khách', 'bán hàng', 'bán cho', 'bán ra', 'xuất kho', 'xuất hàng',
  'khách mua', 'khách lấy', 'khách đặt', 'bán', 'xuất',
]);

function findAction(text: string): { action: TransactionType; index: number; length: number } | null {
  let best: { action: TransactionType; index: number; length: number } | null = null;

  const scan = (list: string[], action: TransactionType) => {
    for (const kw of list) {
      const m = phraseRegex(kw).exec(text);
      if (!m) continue;
      if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) {
        best = { action, index: m.index, length: m[0].length };
      }
    }
  };

  scan(NHAP_KEYWORDS, 'NHAP');
  scan(BAN_KEYWORDS, 'BAN');
  return best;
}

/* ------------------------------------------------------------------ */
/*  Từ đệm                                                             */
/* ------------------------------------------------------------------ */
// Chỉ bỏ ở PHẦN ĐỨNG TRƯỚC từ hành động ("em nhập...", "cho tôi bán...")
// để không cắt nhầm tên hàng như "Sữa Cô Gái Hà Lan".
const PREFIX_FILLERS = new Set([
  'tôi', 'em', 'anh', 'chị', 'bác', 'cô', 'chú', 'mình', 'cho', 'giúp', 'giùm', 'hộ', 'ơi',
]);
// Chỉ bỏ ở CUỐI câu ("... nhé ạ", "... được không")
const SUFFIX_FILLERS = new Set([
  'nhé', 'nha', 'nhá', 'ạ', 'ơi', 'đi', 'với', 'nào', 'được', 'không', 'chưa', 'nhanh', 'luôn',
  'giúp', 'giùm', 'hộ', 'tôi', 'em',
]);
// Bỏ ở bất kỳ đâu
const MID_PHRASES = ['vào kho', 'trong kho', 'ra ngoài'];

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.replace(/^[.,;:!?"'()]+|[.,;:!?"'()]+$/g, ''))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  Hàm chính                                                          */
/* ------------------------------------------------------------------ */
function invalid(transcript: string, message: string, partial: Partial<ParsedVoiceResult> = {}): ParsedVoiceResult {
  return {
    action: null,
    quantity: null,
    unit: 'cái',
    productName: '',
    unitPrice: null,
    totalPrice: null,
    confidence: 0.4,
    isValid: false,
    errorMessage: message,
    rawTranscript: transcript,
    ...partial,
  };
}

export function parseVietnameseCommand(transcript: string): ParsedVoiceResult {
  const raw = transcript.normalize('NFC').trim();
  if (!raw) return invalid(transcript, 'Chưa có dữ liệu giọng nói.', { confidence: 0 });

  // 1. Giá (tách trước để số tiền không bị nhận nhầm thành số lượng)
  let work = raw;
  const priceInfo = extractPrice(work);
  if (priceInfo.price !== null) {
    work = removeSpan(work, priceInfo.index, priceInfo.length);
  }

  // 2. Hành động
  const act = findAction(work);
  let prefixPart = '';
  let restPart = work;
  if (act) {
    prefixPart = work.slice(0, act.index);
    restPart = work.slice(act.index + act.length);
  }

  // Bỏ đại từ/lời nhờ ở phần trước hành động
  const prefixTokens = tokenize(prefixPart).filter((t) => !PREFIX_FILLERS.has(t.toLowerCase()));

  // Bỏ các từ hành động còn sót lại
  let rest = restPart;
  for (const kw of [...NHAP_KEYWORDS, ...BAN_KEYWORDS]) {
    rest = rest.replace(phraseRegex(kw, 'giu'), ' ');
  }
  for (const phrase of MID_PHRASES) {
    rest = rest.replace(phraseRegex(phrase, 'giu'), ' ');
  }

  const tokens = [...prefixTokens, ...tokenize(rest)];
  const lower = tokens.map((t) => t.toLowerCase());

  // 3. Số lượng + đơn vị: ưu tiên cặp "số + đơn vị" (vd "5 thùng", "hai chai")
  const pairs: Array<NumberMatch & { start: number }> = [];
  const anyNumbers: Array<NumberMatch & { start: number }> = [];
  for (let i = 0; i < lower.length; ) {
    const n = parseNumberAt(lower, i);
    if (!n) {
      i++;
      continue;
    }
    const rec = { ...n, start: i };
    anyNumbers.push(rec);
    const next = lower[i + n.length];
    if (next && UNIT_MAP[next]) pairs.push(rec);
    i += n.length;
  }

  if (pairs.length >= 2) {
    return invalid(
      transcript,
      'Câu có nhiều mặt hàng. Hãy nói từng mặt hàng một lần (vd: "bán 2 hộp sữa").',
      { action: act ? act.action : null }
    );
  }

  const chosen = pairs[0] ?? anyNumbers[0] ?? null;
  const consumed = new Set<number>();
  let quantity: number | null = null;
  let unit = 'cái';
  let unitAssumed = true;

  if (chosen) {
    quantity = chosen.value;
    for (let k = 0; k < chosen.length; k++) consumed.add(chosen.start + k);
    const unitIdx = chosen.start + chosen.length;
    if (pairs[0] && lower[unitIdx] && UNIT_MAP[lower[unitIdx]]) {
      unit = UNIT_MAP[lower[unitIdx]];
      unitAssumed = false;
      consumed.add(unitIdx);
    }
  }

  // 4. Tên sản phẩm
  let nameTokens = tokens.filter((_, idx) => !consumed.has(idx));
  while (nameTokens.length && SUFFIX_FILLERS.has(nameTokens[nameTokens.length - 1].toLowerCase())) {
    nameTokens = nameTokens.slice(0, -1);
  }
  nameTokens = nameTokens.filter((t) => !['giùm', 'hộ', 'giúp'].includes(t.toLowerCase()));

  let productName = nameTokens.join(' ').replace(/\s+/g, ' ').trim();
  if (productName) productName = productName.charAt(0).toUpperCase() + productName.slice(1);

  // 5. Tổng tiền
  const unitPrice = priceInfo.price;
  const totalPrice = unitPrice && quantity ? Math.round(unitPrice * quantity) : null;

  // 6. Kiểm tra hợp lệ
  let errorMessage = '';
  if (!act) errorMessage = 'Chưa xác định hành động (Nói "nhập" hoặc "bán").';
  else if (!quantity || quantity <= 0) errorMessage = 'Chưa xác định số lượng hợp lệ (Ví dụ: 10, 5, 2).';
  else if (!productName || productName.length < 2) errorMessage = 'Chưa nhận diện được tên sản phẩm.';

  const isValid = !errorMessage;

  // Độ tin cậy: thấp hơn nếu phải đoán đơn vị hoặc số lượng bất thường
  let confidence = 0.4;
  if (isValid) {
    confidence = 0.95;
    if (unitAssumed) confidence = 0.75;
    if (quantity! > 1000) confidence = Math.min(confidence, 0.5);
  }

  return {
    action: act ? act.action : null,
    quantity,
    unit,
    productName,
    unitPrice,
    totalPrice,
    confidence,
    isValid,
    errorMessage: isValid ? undefined : errorMessage,
    rawTranscript: transcript,
  };
}

/* ------------------------------------------------------------------ */
/*  Nhiều mặt hàng trong một lệnh                                      */
/*  VD: "bán 5 mì hảo hảo chua cay - đọc ghi"                          */
/*      "bán 5 mì hảo hảo chua cay, 1 chai aquafina - ghi"             */
/*  - Tách các đoạn bằng dấu " - ", ";", ", " hoặc "rồi"               */
/*  - Đoạn không có từ hành động sẽ dùng hành động của đoạn trước       */
/*  - Cuối câu: "ghi" = lưu ngay, "đọc" = đọc lại, "đọc ghi" = cả hai    */
/* ------------------------------------------------------------------ */
/* Tách một đoạn thành nhiều mặt hàng khi gặp lại cụm "số + đơn vị".
 * VD: "bán 5 gói mì hảo hảo 5 chai aquafina" -> ["bán 5 gói mì hảo hảo", "5 chai aquafina"]
 * Đoạn đầu giữ nguyên từ hành động; các đoạn sau sẽ nhận hành động mặc định ở bước sau. */
function splitByQuantityUnit(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());
  const cuts: number[] = [];
  let pairSeen = false;
  for (let i = 0; i < tokens.length - 1; i++) {
    const n = parseNumberAt(lower, i);
    if (!n) continue;
    const unitTok = lower[i + n.length];
    if (!unitTok || !UNIT_MAP[unitTok]) continue;
    if (pairSeen && i > 0) cuts.push(i);
    pairSeen = true;
    i += n.length - 1;
  }
  if (cuts.length === 0) return [segment];
  const parts: string[] = [];
  let start = 0;
  for (const c of cuts) {
    parts.push(tokens.slice(start, c).join(' '));
    start = c;
  }
  parts.push(tokens.slice(start).join(' '));
  return parts.filter(Boolean);
}

export interface MultiVoiceResult {
  items: ParsedVoiceResult[];
  readRequested: boolean;
  saveRequested: boolean;
}

const SAVE_TAIL = /(?:^|[\s,.\-;!]+)(đọc[\s,.\-]+)?ghi[\s.!]*$/iu;
const READ_TAIL = /(?:^|[\s,.\-;!]+)đọc[\s.!]*$/iu;
const SEGMENT_SPLIT = /\s+[-–]\s+|\s*;\s*|,\s+|\s+rồi\s+|\s+(?:cộng|thêm|với|cùng với|và)\s+(?=\S+\s+(?:chai|lon|gói|hộp|lốc|thùng|túi|cái|con|bánh|cuộn|hũ|cây|tuýp|vỉ|bịch)\b|\d)/iu;

export function parseVietnameseMulti(
  transcript: string,
  defaultAction: TransactionType | null = null
): MultiVoiceResult {
  let work = transcript.normalize('NFC').trim();
  let readRequested = false;
  let saveRequested = false;

  const saveMatch = work.match(SAVE_TAIL);
  if (saveMatch && saveMatch.index !== undefined) {
    saveRequested = true;
    readRequested = Boolean(saveMatch[1]);
    work = work.slice(0, saveMatch.index).trim();
  } else {
    const readMatch = work.match(READ_TAIL);
    if (readMatch && readMatch.index !== undefined) {
      readRequested = true;
      work = work.slice(0, readMatch.index).trim();
    }
  }

  // Tách theo dấu câu / từ nối trước
  const coarse = work.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  // Nhận dạng giọng nói thường KHÔNG có dấu phẩy: tách tiếp tại mỗi "số + đơn vị" mới
  const segments = coarse.flatMap(splitByQuantityUnit);

  const items: ParsedVoiceResult[] = [];
  // Đoạn không nói hành động thì dùng hành động trước đó, hoặc mặc định của phiên
  let lastAction: TransactionType | null = defaultAction;

  for (const seg of segments) {
    const hasAction = findAction(seg);
    const text = !hasAction && lastAction
      ? `${lastAction === 'NHAP' ? 'nhập' : 'bán'} ${seg}`
      : seg;

    const r = parseVietnameseCommand(text);
    if (r.action) lastAction = r.action;
    items.push({ ...r, rawTranscript: transcript });
  }

  return { items, readRequested, saveRequested };
}

/**
 * GOM LỆNH: cộng dồn các mặt hàng mới nói vào giỏ đang chờ.
 * Cùng hành động + cùng mặt hàng + cùng đơn vị + cùng đơn giá thì CỘNG SỐ LƯỢNG
 * (vd: "5 chai aquafina" rồi "5 chai aquafina" nữa -> 10 chai).
 * Dòng chưa rõ / còn nhập nhằng được giữ riêng để người dùng sửa hoặc bỏ.
 */
export function mergePendingItems(
  existing: ParsedVoiceResult[],
  incoming: ParsedVoiceResult[]
): ParsedVoiceResult[] {
  const key = (p: ParsedVoiceResult) =>
    [p.action, p.productName.trim().toLowerCase(), (p.unit || '').trim().toLowerCase(), p.unitPrice ?? ''].join('|');
  const mergeable = (p: ParsedVoiceResult) =>
    p.isValid && !!p.action && !!p.quantity && !!p.productName && p.matchStatus !== 'ambiguous' && p.matchStatus !== 'unknown';

  const out = existing.map((p) => ({ ...p }));
  for (const inc of incoming) {
    const idx = mergeable(inc) ? out.findIndex((o) => mergeable(o) && key(o) === key(inc)) : -1;
    if (idx < 0) {
      out.push({ ...inc });
      continue;
    }
    const cur = out[idx];
    const qty = (cur.quantity as number) + (inc.quantity as number);
    const unitPrice = cur.unitPrice ?? inc.unitPrice ?? null;
    const total =
      cur.totalPrice != null && inc.totalPrice != null
        ? cur.totalPrice + inc.totalPrice
        : unitPrice
          ? Math.round(unitPrice * qty)
          : cur.totalPrice ?? inc.totalPrice ?? null;
    out[idx] = {
      ...cur,
      quantity: qty,
      totalPrice: total,
      rawTranscript:
        cur.rawTranscript === inc.rawTranscript ? cur.rawTranscript : `${cur.rawTranscript} | ${inc.rawTranscript}`,
    };
  }
  return out;
}
