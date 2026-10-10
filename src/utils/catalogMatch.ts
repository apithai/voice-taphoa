/**
 * Khớp tên sản phẩm người dùng NÓI (ngắn) với danh mục (tên dài).
 * Ví dụ: "mì hảo hảo tôm chua cay" -> "Mì Hảo Hảo tôm chua cay gói 75g"
 *
 * Nguyên tắc: khi có nhiều ứng viên ngang nhau thì KHÔNG tự chọn,
 * trả về danh sách để người dùng bấm chọn.
 */

export interface CatalogItem {
  name: string; // tên đầy đủ trong danh mục
  unit: string;
  sellPrice: number;
  importPrice: number;
  aliases: string[]; // các cách gọi khác: ["hảo hảo", "mì hảo hảo"]
}

export interface MatchCandidate {
  item: CatalogItem;
  score: number; // điểm tổng (0..1+)
  coverage: number; // tỉ lệ từ người nói được tìm thấy (0..1)
}

export interface MatchOutcome {
  best: MatchCandidate | null;
  candidates: MatchCandidate[]; // tối đa `limit` ứng viên tốt nhất
  confident: boolean; // true nếu có thể tự chọn `best` mà không cần hỏi
}

/** Bỏ dấu, chữ thường, tách chữ và số ("st25" -> "st 25"), bỏ ký tự lạ */
export function normalizeText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Từ chỉ quy cách, thường có trong tên danh mục nhưng ít khi được nói
const NOISE = new Set(['g', 'gr', 'gam', 'gram', 'ml', 'kg', 'l', 'lit', 'loai']);

export function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t && !NOISE.has(t));
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) {
      i++;
    } else {
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Độ giống giữa 2 từ: 1 = giống hệt, 0.8 = sai 1 ký tự, 0.7 = từ này là đầu từ kia */
function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4 && editDistanceAtMost1(a, b)) return 0.8;
  if (minLen >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.7;
  return 0;
}

function scoreTokens(spoken: string[], cand: string[]): { coverage: number; specificity: number } {
  if (!spoken.length || !cand.length) return { coverage: 0, specificity: 0 };
  const used = new Set<number>();
  let sum = 0;
  let matched = 0;

  for (const s of spoken) {
    let bestSim = 0;
    let bestIdx = -1;
    for (let i = 0; i < cand.length; i++) {
      if (used.has(i)) continue;
      const sim = tokenSim(s, cand[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      sum += bestSim;
      matched++;
    }
  }
  return { coverage: sum / spoken.length, specificity: matched / cand.length };
}

/**
 * @param spokenName  tên sản phẩm lấy từ câu nói
 * @param spokenUnit  đơn vị nhận được (chỉ dùng để phân xử khi các ứng viên ngang nhau)
 */
export function matchProduct(
  spokenName: string,
  spokenUnit: string,
  catalog: CatalogItem[],
  limit = 3
): MatchOutcome {
  const spoken = tokenize(spokenName);
  if (!spoken.length || !catalog.length) {
    return { best: null, candidates: [], confident: false };
  }
  const unitKey = normalizeText(spokenUnit);

  const scored: MatchCandidate[] = [];
  for (const item of catalog) {
    let bestScore = 0;
    let bestCoverage = 0;
    for (const label of [item.name, ...(item.aliases || [])]) {
      const { coverage, specificity } = scoreTokens(spoken, tokenize(label));
      const score = coverage * 0.85 + specificity * 0.15;
      if (score > bestScore) {
        bestScore = score;
        bestCoverage = coverage;
      }
    }
    if (bestCoverage < 0.5) continue;
    if (unitKey && normalizeText(item.unit) === unitKey) bestScore += 0.1;
    scored.push({ item, score: bestScore, coverage: bestCoverage });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, limit);
  const best = candidates[0] ?? null;
  const second = candidates[1];

  const confident =
    !!best && best.coverage >= 0.9 && (!second || best.score - second.score >= 0.08);

  return { best, candidates, confident };
}

/** Phân tích file CSV/Excel xuất ra (đã dán thành text) thành danh mục. Cột: Tên, Đơn vị, Giá bán, Giá nhập, Tên gọi khác */
export function parseCatalogRows(rows: unknown[][]): CatalogItem[] {
  const toNum = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const d = String(v ?? '').replace(/[^\d]/g, '');
    return d ? Number(d) : 0;
  };
  const items: CatalogItem[] = [];
  for (const r of rows) {
    const name = String(r[0] ?? '').trim();
    if (!name) continue;
    items.push({
      name,
      unit: String(r[1] ?? '').trim() || 'cái',
      sellPrice: toNum(r[2]),
      importPrice: toNum(r[3]),
      aliases: String(r[4] ?? '')
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return items;
}
