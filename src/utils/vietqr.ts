/**
 * Tạo link ảnh mã QR chuyển khoản VietQR (có sẵn số tiền và nội dung).
 * Định dạng: https://img.vietqr.io/image/<BANK_ID>-<ACCOUNT_NO>-<TEMPLATE>.png?amount=&addInfo=&accountName=
 */
export interface BankInfo {
  bankId: string; // tên viết tắt ngân hàng theo VietQR ("MB", "VCB", "TCB"...) hoặc mã BIN 6 số
  accountNo: string;
  accountName?: string;
  template?: string; // mặc định "compact2"
}

/** Nội dung chuyển khoản: không dấu, chỉ chữ và số, tối đa 25 ký tự (yêu cầu của ngân hàng) */
export function buildTransferNote(txId: string): string {
  return ('VS' + String(txId || '').replace(/[^A-Za-z0-9]/g, '')).slice(0, 25);
}

/** Trả về '' nếu chưa cấu hình tài khoản hoặc số tiền không hợp lệ */
export function buildVietQrUrl(bank: BankInfo | null | undefined, amount: number, txId: string): string {
  const money = Math.round(Number(amount) || 0);
  const bankId = (bank?.bankId || '').trim();
  const accountNo = (bank?.accountNo || '').trim();
  if (!bankId || !accountNo || money <= 0) return '';

  const query = [`amount=${money}`, `addInfo=${encodeURIComponent(buildTransferNote(txId))}`];
  if (bank?.accountName && bank.accountName.trim()) {
    query.push(`accountName=${encodeURIComponent(bank.accountName.trim())}`);
  }
  return (
    `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-` +
    `${encodeURIComponent((bank?.template || 'compact2').trim())}.png?${query.join('&')}`
  );
}
