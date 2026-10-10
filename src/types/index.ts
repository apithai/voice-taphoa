export type TransactionType = 'NHAP' | 'BAN';

export interface Transaction {
  id: string;
  batchId?: string; // các mặt hàng nói trong cùng một lệnh có chung mã lô
  timestamp: string; // ISO string
  formattedTime: string; // HH:mm:ss DD/MM/YYYY
  type: TransactionType;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  rawTranscript: string;
  priceAuto?: boolean; // true = giá do app tự điền từ danh mục (Sheet sẽ tra lại giá mới nhất)
  syncedSheets?: boolean;
  sheetsSyncStatus?: 'sent_unconfirmed' | 'failed' | 'not_sent';
  syncedTelegram?: boolean;
}

export interface InventoryItem {
  productName: string;
  unit: string;
  totalImport: number;
  totalExport: number;
  currentStock: number;
  lastUpdated: string;
  sellPrice?: number;
  importPrice?: number;
}

export interface AppSettings {
  googleSheetsWebhook: string;
  telegramBotToken: string;
  telegramChatId: string;
  autoSaveSeconds: number;
  autoSaveEnabled: boolean;
  voiceFeedbackEnabled: boolean;
  speechRate: number;
  beepSoundEnabled: boolean;
  bankId?: string;
  bankAccountNo?: string;
  bankAccountName?: string;
}

import type { CatalogItem } from '../utils/catalogMatch';

export interface ParsedVoiceResult {
  matchStatus?: 'matched' | 'ambiguous' | 'unknown' | 'no_catalog';
  candidates?: CatalogItem[];
  unitNote?: string;
  action: TransactionType | null;
  quantity: number | null;
  unit: string;
  productName: string;
  unitPrice?: number | null;
  totalPrice?: number | null;
  priceAuto?: boolean;
  confidence: number;
  isValid: boolean;
  errorMessage?: string;
  rawTranscript: string;
}
